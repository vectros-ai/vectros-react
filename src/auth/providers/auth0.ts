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
import type { PartnerApiResolvedScope } from '../vectrosApiTokenCache';
import { parseResolvedScope } from '../vectrosApiTokenCache';

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
 *   presented, only the Auth0 ACCESS token (see {@link Auth0AuthProvider.exchangeToken}'s
 *   own doc for why it's the access token and not the ID token).
 * - `authorizationParams.audience` — the Auth0 API identifier this app's
 *   Auth0 application is authorized for. Vectros's exchange handler resolves
 *   the target tenant + context from the registered `(issuer, audience)`
 *   pair — this MUST match the `audience` value the tenant owner registered
 *   for this issuer. **Required for `exchangeToken` to work at all** — Auth0
 *   only mints a real, verifiable JWT access token when a custom audience is
 *   requested; omitting this makes `client.getTokenSilently()` return an
 *   OPAQUE (non-JWT) access token instead, which the exchange endpoint cannot
 *   verify. This provider does not (and cannot, from the client alone) guard
 *   against that misconfiguration — it fails at the exchange endpoint, not here.
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
  /**
   * camelCase — a Vectros-specific extension to the RFC 8693 envelope, not
   * part of the RFC, so not snake_case like the fields above: the token's
   * resolved `allowedActions`/`identity`, parsed via {@link parseResolvedScope}.
   */
  readonly resolvedScope?: unknown;
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

/**
 * Best-effort detection of Auth0's "please verify your email" rejection.
 *
 * Live-tested 2026-08-26: signing up fresh (email verification required on
 * the connection, as it should be) and immediately attempting to sign in
 * fails silently from the user's perspective — no token ever reaches this
 * app, the SDK's `handleRedirectCallback()` throws, and before this fix
 * every such throw mapped to the generic `UNKNOWN` code (a static "something
 * went wrong" with no indication a verification email was even sent). The
 * ONE thing distinguishing it from every other rejection is the error text
 * Auth0 puts on the OAuth error redirect — its documented default is
 * `error=unauthorized&error_description=Please verify your email before
 * logging in.` — which `auth0-spa-js` surfaces as a plain `Error` carrying
 * that description as `.message`.
 *
 * Matched by PATTERN (verify + email, both present, case-insensitive) rather
 * than the exact default string: Auth0 lets a tenant customize this text, and
 * a future Auth0 dashboard copy change shouldn't silently regress this back
 * to UNKNOWN. Deliberately conservative in the other direction too — this
 * must never fire on an unrelated message that happens to mention "email"
 * (e.g. a real network error touching an email field) without also
 * mentioning verification.
 */
function looksLikeUnverifiedEmailError(message: string): boolean {
  return /verif(?:y|ied|ication)/i.test(message) && /e-?mail/i.test(message);
}

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
  if (looksLikeUnverifiedEmailError(e.message)) {
    return new AuthError('EMAIL_NOT_VERIFIED', e.message);
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
 * How long to wait before the one-shot self-signup-race retry in
 * {@link Auth0AuthProvider.exchangeToken} below. Short enough not to be a
 * noticeable UI stall; long enough to clear a same-second concurrent write
 * on the other side of the race.
 */
const EXCHANGE_RACE_RETRY_DELAY_MS = 400;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
   * Exchange the current Auth0 session for a Vectros partner-API `st_*`
   * bearer via `POST /v1/auth/token/exchange` (RFC 8693 token exchange).
   *
   * Presents the ACCESS token, not the ID token, and this is load-bearing:
   * the exchange contract requires the presented token's `aud` claim to
   * equal the audience recorded on the registered issuer. An ID token's
   * `aud` is always the requesting client id — that's OIDC's own rule, not
   * an Auth0 quirk — so it can never carry a custom API audience. The
   * access token does, because it's minted against
   * `config.authorizationParams.audience` (the constructor above), and
   * Auth0 issues it as a real, verifiable JWT whenever a custom audience is
   * requested. Sent under the generic `...token-type:jwt` label, since
   * `...token-type:access_token` isn't one the exchange endpoint accepts.
   *
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
   *
   * **One bounded retry on a 403 — but NOT when `inviteToken` is set.** The exchange endpoint
   * deliberately returns the SAME generic `403 invalid_grant` for several distinct server-side
   * rejections (uniform-not-found discipline — see the endpoint's own contract doc) — this client
   * can't tell them apart, and must not guess. But one of those causes is genuinely transient: two
   * near-simultaneous first-time exchanges for the SAME brand-new identity race each other
   * server-side, and the loser gets this exact 403 even though the identity now exists and an
   * immediate retry would match it directly (observed live, 2026-08-21 — a StrictMode-driven
   * double-mount fired this exact race in local dev; the underlying hazard isn't StrictMode-specific,
   * just easiest to trigger there). A single retry after a short delay costs little on every OTHER
   * cause of a 403 (a missing role, an elevated-scope block, a torn-down context, a still-unresolved
   * self-signup policy, a SUSPENDED access profile) — those fail again identically.
   *
   * **The suspended-profile cause is new, and it is the one that makes "costs nothing" too
   * strong.** The exchange used to serve a memoized scope without re-reading the profile's status,
   * so suspending a profile did not stop this endpoint minting against it for up to five minutes;
   * it now re-reads that status on every request and refuses immediately with the same uniform
   * 403. That is a permanent condition, not a race, so a suspended member's every exchange attempt
   * now costs two real calls to this endpoint rather than one. Deliberately left as is: the
   * endpoint discloses no cause, so this client cannot suppress the retry for THIS 403 without
   * suppressing it for the transient one it exists to absorb — and a doubled request on a signed-in
   * member's own session is a smaller cost than losing the race recovery.
   *
   * **Why `inviteToken` is the one case excluded, not `signupType`.** The race lives entirely
   * inside the server's self-signup path, which the server itself SKIPS whenever an `invite_token`
   * is present (an invite attempt either succeeds or fails as an invite — it never falls through to
   * self-signup, by the endpoint's own documented contract). So a 403 with `inviteToken` set is
   * never this race — it's a real invite-bind rejection (bad/expired/already-used token), and
   * retrying it only doubles load on that endpoint for zero benefit, which matters most during the
   * exact incident/misconfiguration window when it's least wanted (`TokenExchangeFunction` has no
   * rate limiter of its own — see its own CFN comment). `signupType`, by contrast, does NOT gate the
   * self-signup path at all (the server resolves the tenant's sole policy whether or not the client
   * names it) — an explicit self-signup page passing `signupType` hits the identical race an
   * ordinary cache-driven re-mint does, so it stays covered by the retry.
   *
   * **`skipOwnRetry` — internal, set ONLY by {@link mintPartnerApiToken}.** This same 403 race is
   * now ALSO retried one layer up, inside `vectrosApiTokenCache.ts`'s own `getVectrosApiToken`
   * (`SHARED_MINT_RETRY_DELAY_MS`, added 2026-08-26, five days after this retry) — a
   * provider-agnostic retry that additionally coalesces every consumer arriving during the delay
   * window onto ONE shared attempt, which a per-call retry here structurally cannot do. Every
   * ordinary re-mint (`mintPartnerApiToken`, the cache's only caller) went through BOTH layers
   * unreconciled: a persistent 403 retried here (2 fetches), THEN again one layer up on the cache's
   * own retry (2 more fetches) — up to 4 real `POST /v1/auth/token/exchange` calls in quick
   * succession for one mint, measured live on a fresh sign-in right after invite-accept.
   * `mintPartnerApiToken` sets this to defer the race ENTIRELY to the cache's shared retry, so the
   * two layers no longer stack. A direct `exchangeToken()` call that bypasses the cache (self-signup
   * via `signupType`, `acceptInvite`) leaves this unset and keeps its own retry — nothing else
   * covers that race for those callers.
   */
  async exchangeToken(options?: {
    readonly inviteToken?: string;
    readonly signupType?: string;
    readonly contextId?: string;
    readonly skipOwnRetry?: boolean;
  }): Promise<{
    readonly token: string;
    readonly expiresAtMs: number;
    readonly resolvedScope: PartnerApiResolvedScope;
  }> {
    let accessToken: string;
    try {
      accessToken = await this.client.getTokenSilently();
    } catch {
      throw new AuthError('INVALID_CREDENTIALS', 'Not authenticated — cannot exchange a token.');
    }

    const attempt = async (): Promise<Response> => {
      try {
        return await fetch(this.config.exchangeEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
            subject_token: accessToken,
            subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
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
    };

    let resp = await attempt();
    if (resp.status === 403 && !options?.inviteToken && !options?.skipOwnRetry) {
      await delay(EXCHANGE_RACE_RETRY_DELAY_MS);
      resp = await attempt();
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
    return {
      token: data.access_token,
      expiresAtMs: Date.now() + data.expires_in * 1000,
      resolvedScope: parseResolvedScope(data.resolvedScope),
    };
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
   *
   * `skipOwnRetry: true` — this is THE cache-driven path, so the 403-race
   * retry is left entirely to `vectrosApiTokenCache.ts`'s own shared retry;
   * see `exchangeToken`'s doc for why stacking both here produced up to 4
   * real exchange calls for one mint.
   */
  async mintPartnerApiToken(
    _tenantId?: unknown,
    contextId?: string,
  ): Promise<{
    readonly token: string;
    readonly expiresAtMs: number;
    readonly resolvedScope: PartnerApiResolvedScope;
  }> {
    return this.exchangeToken({ ...(contextId ? { contextId } : {}), skipOwnRetry: true });
  }

  /** {@link HostedRedirectAuth.acceptInvite} — a thin `exchangeToken` wrapper that
   *  discards the returned token on purpose; see that interface's own doc for why. */
  async acceptInvite(inviteToken: string): Promise<void> {
    await this.exchangeToken({ inviteToken });
  }
}
