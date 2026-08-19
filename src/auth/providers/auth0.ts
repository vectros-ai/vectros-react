// ---------------------------------------------------------------------------
// Auth0AuthProvider — Auth0 Universal Login (hosted-redirect) implementation
// of AuthProviderAdapter + HostedRedirectAuth.
//
// Deliberately does NOT implement EmbeddedCredentialAuth or
// VectrosTenancyProvider — see types.ts's file-header note for why both are
// structural, not "not built yet":
//   - Under Universal Login, Auth0's own hosted pages own the ENTIRE
//     sign-in/signup/password-reset/change-password/MFA ceremony end to end.
//     There is nothing for this app to drive via signUp/confirmSignIn/
//     forgotPassword/getMfaStatus/etc. — the redirect either succeeds or
//     fails; there is no mid-flow challenge state visible to the SPA. Auth0
//     DOES also offer an "Embedded Login" mode (its Authentication API +
//     Resource Owner Password Grant + the MFA API) that maps onto
//     EmbeddedCredentialAuth almost 1:1 — but Auth0 itself recommends against
//     it for browser SPAs specifically (PKCE, no raw-credential handling in
//     this app's JS, cross-app SSO, uniform behavior across
//     enterprise/social connections ROPG can't reach at all). A fork wanting
//     that shape instead should write a sibling `auth0Embedded.ts`, not
//     extend this file.
//   - Multi-tenancy (getMemberships/etc.) is structurally impossible here:
//     the Vectros token-exchange endpoint pins one registered Auth0 issuer to
//     exactly one (tenant, context), permanently — there is no second tenant
//     an exchange-only caller could ever discover or switch to.
//
// mintPartnerApiToken / exchangeToken below are — like
// CognitoAuthProvider.mintPartnerApiToken — deliberately NOT part of any of
// the four shared interfaces. They're the Vectros-specific bridge: the host
// app wires mintPartnerApiToken into the shared token cache via
// setPartnerApiTokenMinter (main.tsx, same seam Cognito uses), and an
// accept-invitation page calls exchangeToken({ inviteToken }) directly for
// the one-time first exchange.
// ---------------------------------------------------------------------------

import { Auth0Client } from '@auth0/auth0-spa-js';
import type { IdToken } from '@auth0/auth0-spa-js';

import { AuthError } from '../errors';
import type { AuthProviderAdapter, AuthUser, HostedRedirectAuth } from '../types';

/**
 * Deployment-specific configuration the Auth0 provider needs, injected by the
 * host app rather than hard-coded in the library (so a fork points it at its
 * own Auth0 tenant + Vectros deployment).
 *
 * - `domain` / `clientId` — the Auth0 application's own identifiers (Auth0
 *   Dashboard → Applications → your SPA application).
 * - `redirectUri` — must exactly match an "Allowed Callback URL" configured
 *   on the Auth0 application; this is the app's own callback ROUTE (e.g.
 *   `https://app.example.com/callback`), not an Auth0 URL.
 * - `exchangeEndpoint` — the full URL of Vectros's `POST /v1/auth/token/exchange`
 *   route (e.g. `https://api.vectros.ai/v1/auth/token/exchange`), an RFC 8693
 *   token-exchange endpoint. Unauthenticated — no Vectros credential is
 *   presented, only the Auth0 ID token.
 * - `authorizationParams.audience` — the Auth0 API identifier this app's
 *   Auth0 application is authorized for. Vectros's exchange handler resolves
 *   the target tenant + context from the registered `(issuer, audience)`
 *   pair — this MUST match the `audience` value the tenant owner registered
 *   for this issuer.
 */
export interface Auth0AuthProviderConfig {
  readonly domain: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly exchangeEndpoint: string;
  readonly authorizationParams?: {
    readonly audience?: string;
    readonly scope?: string;
  };
}

/** Wire shape of `POST /v1/auth/token/exchange`'s success response (RFC 8693 §2.2.1). */
interface ExchangeSuccessResponse {
  readonly access_token: string;
  readonly expires_in: number;
}

/** Wire shape of the exchange endpoint's OAuth-standard error envelope (RFC 6749 §5.2). */
interface ExchangeErrorResponse {
  readonly error?: string;
  readonly error_description?: string;
}

// ---------------------------------------------------------------------------
// Error mapping — every method that talks to the Auth0Client SDK must map its
// errors to AuthError at the adapter boundary (types.ts's shared contract:
// "Provider adapters translate their SDK's native error vocabulary... so
// consumer pages pattern-match only on error.code"). auth0-spa-js's own
// vocabulary (OAuth-flavored: access_denied, login_required, timeout, a
// missing/expired PKCE transaction, etc.) has no clean match against
// AuthErrorCode's Cognito-shaped set (INVALID_CREDENTIALS, CODE_MISMATCH,
// etc. — those describe a credential ceremony this hosted-redirect provider
// never runs) — so this maps everything to UNKNOWN except a genuine network
// failure, preserving the SDK's own message as the diagnostic. The point
// isn't finer-grained codes here; it's that every error is an AuthError
// instance, so `instanceof AuthError` / authErrorToMessage's dispatch never
// silently falls through to a generic message for an Auth0-caused failure.
// ---------------------------------------------------------------------------

function mapAuth0Error(e: unknown): AuthError {
  if (e instanceof AuthError) return e;
  if (!(e instanceof Error)) {
    return new AuthError('UNKNOWN', 'An unexpected error occurred.');
  }
  // Best-effort network-failure detection — auth0-spa-js surfaces a fetch
  // failure as a plain TypeError (the fetch spec's own shape), same as the
  // browser's native fetch does for a DNS/offline failure.
  if (e.name === 'TypeError' && /fetch|network/i.test(e.message)) {
    return new AuthError('NETWORK_ERROR', e.message);
  }
  return new AuthError('UNKNOWN', e.message);
}

/** Wraps an Auth0Client call so any thrown error is mapped to AuthError before propagating. */
async function tryAuth0<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw mapAuth0Error(e);
  }
}

/**
 * Concrete AuthProviderAdapter + HostedRedirectAuth backed by Auth0 Universal
 * Login via @auth0/auth0-spa-js.
 */
export class Auth0AuthProvider implements AuthProviderAdapter, HostedRedirectAuth {
  private readonly client: Auth0Client;

  constructor(private readonly config: Auth0AuthProviderConfig) {
    this.client = new Auth0Client({
      domain: config.domain,
      clientId: config.clientId,
      authorizationParams: {
        redirect_uri: config.redirectUri,
        ...(config.authorizationParams?.audience
          ? { audience: config.authorizationParams.audience }
          : {}),
        ...(config.authorizationParams?.scope ? { scope: config.authorizationParams.scope } : {}),
      },
      // Refresh-token rotation is the modern, ITP/third-party-cookie-safe way
      // to renew a session silently (vs. the iframe `prompt=none` fallback,
      // which Safari/Chrome increasingly break) — requires `offline_access`.
      useRefreshTokens: true,
      cacheLocation: 'localstorage',
    });
  }

  async getCurrentUser(): Promise<AuthUser | null> {
    try {
      // Derive presence + identity from the SAME decoded ID-token claims
      // getIdToken() below reads — NOT client.isAuthenticated() +
      // client.getUser() separately. auth0-spa-js's isAuthenticated() calls
      // getUser() internally, and getUser()/getIdTokenClaims() both bottom
      // out in the same cache-read + decode — so the two-call version did
      // that work three times over on every probe (mount, post-sign-in
      // refresh, post-redirect-callback refresh) for no benefit. A JWT ID
      // token's standard claims already carry sub/email/given_name/family_name.
      const claims = await this.freshIdTokenClaims();
      const sub = claims?.sub;
      const email = typeof claims?.email === 'string' ? claims.email : undefined;
      if (!sub || !email) return null;
      const givenName = claims?.['given_name'];
      const familyName = claims?.['family_name'];
      return {
        sub,
        email,
        firstName: typeof givenName === 'string' ? givenName : null,
        lastName: typeof familyName === 'string' ? familyName : null,
      };
    } catch {
      // Contract: MUST NOT throw on "no session" — return null instead.
      return null;
    }
  }

  async signOut(): Promise<void> {
    // Auth0's logout ALSO navigates the whole page away (to clear the
    // hosted-session cookie on Auth0's own domain) unless told not to — same
    // shape as signInWithRedirect below: this promise may not meaningfully
    // resolve before the browser unloads.
    await tryAuth0(() =>
      this.client.logout({
        logoutParams: { returnTo: window.location.origin },
      }),
    );
  }

  async getIdToken(): Promise<string | null> {
    try {
      const claims = await this.freshIdTokenClaims();
      return claims?.__raw ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Reads the current ID-token claims, refreshing first if the cached token
   * is stale. `getIdTokenClaims()` alone is a pure cache read — auth0-spa-js
   * never refreshes on it — so a tab left open past the cached token's
   * lifetime would otherwise read a stale/expired entry forever, either
   * handing callers an expired JWT or reading as "no session" and silently
   * signing the user out mid-session. `getTokenSilently()` is the SDK's only
   * call that actually refreshes: a cache hit costs nothing extra (no
   * network), an expired one triggers a silent refresh via the rotating
   * refresh token (`useRefreshTokens: true` above) before this reads claims
   * back out. Callers must still handle "no session" — this throws
   * (`login_required`) exactly like a plain cache-miss would.
   */
  private async freshIdTokenClaims(): Promise<IdToken | undefined> {
    await this.client.getTokenSilently();
    return this.client.getIdTokenClaims();
  }

  async signInWithRedirect(options?: { readonly returnTo?: string }): Promise<void> {
    await tryAuth0(() =>
      this.client.loginWithRedirect({
        appState: options?.returnTo ? { returnTo: options.returnTo } : undefined,
      }),
    );
  }

  async handleRedirectCallback(): Promise<void> {
    // Only process an actual redirect result — a plain visit to the callback
    // route (refresh, direct navigation) has no code/state/error to consume.
    // Guards against re-exchanging an already-spent authorization code on
    // refresh, which auth0-spa-js would otherwise throw on. Matched as exact
    // query-param KEYS via URLSearchParams, not a substring test — `.includes
    // ('code=')` would also match an unrelated param like `?promo_code=…` or
    // `?zip_code=…`, sending a stray visit into the SDK's own callback
    // handler, which throws (no stored PKCE transaction to match).
    const params = new URLSearchParams(window.location.search);
    if (!params.has('code') && !params.has('error')) return;
    try {
      await tryAuth0(() => this.client.handleRedirectCallback());
    } finally {
      // Strip the code/state (or error) query params so a refresh of this
      // route never re-attempts the exchange. Best-effort — history API
      // failures (e.g. no History support) must not mask the real outcome.
      try {
        window.history.replaceState({}, document.title, window.location.pathname);
      } catch {
        // ignore — cosmetic only
      }
    }
  }

  /**
   * Exchange the current Auth0 ID token for a Vectros partner-API `st_*`
   * bearer via `POST /v1/auth/token/exchange` (RFC 8693 token exchange).
   * `inviteToken`/`signupType` are forwarded on the request body for the
   * one-time first-exchange cases (accepting an invitation, or self-service
   * signup) — an accept-invitation or self-signup page calls this directly
   * with one of them; ordinary (re-)mints from the token cache go through
   * {@link mintPartnerApiToken}, which calls this with neither but does
   * forward `contextId`. `contextId` disambiguates which registered app
   * context to target when this issuer is registered against more than one
   * (each via its own `POST /v1/auth/issuers` row + audience) — omit it when
   * the issuer serves exactly one, the common case, which this field's
   * addition doesn't change.
   */
  async exchangeToken(options?: {
    readonly inviteToken?: string;
    readonly signupType?: string;
    readonly contextId?: string;
  }): Promise<{ readonly token: string; readonly expiresAtMs: number }> {
    const idToken = await this.getIdToken();
    if (!idToken) {
      throw new AuthError('INVALID_CREDENTIALS', 'Not authenticated — cannot exchange a token.');
    }
    let resp: Response;
    try {
      resp = await fetch(this.config.exchangeEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
          subject_token: idToken,
          subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
          ...(options?.inviteToken ? { invite_token: options.inviteToken } : {}),
          ...(options?.signupType ? { signup_type: options.signupType } : {}),
          ...(options?.contextId ? { context_id: options.contextId } : {}),
        }),
      });
    } catch (e) {
      throw new AuthError(
        'NETWORK_ERROR',
        e instanceof Error ? e.message : 'Token exchange request failed.',
      );
    }
    if (!resp.ok) {
      const body = (await resp.json().catch(() => null)) as ExchangeErrorResponse | null;
      // The server deliberately keeps 401/403/404 bodies generic (uniform
      // not-found) — surface the status + OAuth `error` code as diagnostics,
      // never invent a more specific client-side distinction than the server
      // itself makes.
      throw new AuthError(
        'UNKNOWN',
        `Token exchange failed: ${resp.status} ${body?.error ?? ''} ${body?.error_description ?? ''}`.trim(),
      );
    }
    const data = (await resp.json()) as ExchangeSuccessResponse;
    return { token: data.access_token, expiresAtMs: Date.now() + data.expires_in * 1000 };
  }

  /**
   * `PartnerApiTokenMinter`-shaped wrapper around {@link exchangeToken} for
   * ordinary (re-)mints, wired via `setPartnerApiTokenMinter` at app boot —
   * the same seam `CognitoAuthProvider.mintPartnerApiToken` uses. Accepts
   * (and ignores) `tenantId`: unlike Cognito's multi-tenant mint, Auth0's
   * exchange resolves the target TENANT entirely server-side from the
   * registered issuer — there is nothing for the caller to select there.
   * `contextId` IS forwarded (0.40.0): when the issuer is registered against
   * more than one app context, this is how the cache's per-(tenant, context)
   * mint disambiguates which one to target. Omitted/undefined when the
   * issuer serves exactly one — unaffected by this field's addition.
   */
  async mintPartnerApiToken(
    _tenantId?: unknown,
    contextId?: string,
  ): Promise<{ readonly token: string; readonly expiresAtMs: number }> {
    return this.exchangeToken(contextId ? { contextId } : undefined);
  }
}
