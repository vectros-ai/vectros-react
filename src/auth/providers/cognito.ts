// ---------------------------------------------------------------------------
// CognitoAuthProvider — AWS Cognito implementation of AuthProviderAdapter.
//
// This is the ONLY file that imports from `aws-amplify`. The rest of the
// codebase sees only the AuthProviderAdapter interface from ../types.
//
// To swap auth providers in a fork:
//   1. Write a sibling file in this directory (e.g. auth0.ts) implementing
//      AuthProviderAdapter against your provider's SDK.
//   2. Update the `new CognitoAuthProvider()` line in src/main.tsx.
//   3. (Optional) Delete this file.
//
// Mapping notes for partners porting this pattern:
//   - Cognito requires the `custom:<key>` prefix for app-defined attributes.
//     The metadata-bag → custom-attribute translation is the most common
//     point of divergence across providers; isolate it here.
//   - Amplify's `nextStep.signInStep` enumeration is provider-specific
//     (see https://docs.amplify.aws/react/build-a-backend/auth/concepts/
//     usernames-and-passwords/sign-in/). The mapSignInStep() helper below
//     normalizes the known set onto our SignInResult union. Unknown step
//     values throw, which is intentional — silent fall-through on a new
//     Amplify version is a real-world security risk.
//   - amplifySignOut({ global: true }) invalidates refresh tokens across
//     ALL of the user's sessions. We default to global sign-out to defend
//     against stolen-refresh-token replay; partner forks with shared-device
//     flows may want to switch this to local-only.
// ---------------------------------------------------------------------------

import {
  confirmResetPassword,
  confirmSignIn as amplifyConfirmSignIn,
  confirmSignUp as amplifyConfirmSignUp,
  fetchAuthSession,
  fetchMFAPreference,
  fetchUserAttributes,
  getCurrentUser as amplifyGetCurrentUser,
  resendSignUpCode as amplifyResendSignUpCode,
  resetPassword,
  setUpTOTP as amplifySetUpTOTP,
  signIn as amplifySignIn,
  signOut as amplifySignOut,
  signUp as amplifySignUp,
  updateMFAPreference,
  updatePassword,
  verifyTOTPSetup,
} from 'aws-amplify/auth';

import { decodeJwt } from 'jose';

import { AuthError } from '../errors';
import type {
  AppContextSummary,
  ListAppContextsOptions,
  AuthProviderAdapter,
  AuthUser,
  ChangePasswordInput,
  ConfirmForgotPasswordInput,
  ConfirmSignInInput,
  ConfirmSignUpInput,
  ForgotPasswordInput,
  MfaMethod,
  MfaStatus,
  SignInInput,
  SignInResult,
  LinkInvitationResult,
  SignUpInput,
  SignUpResult,
  TenantId,
  TenantMembership,
  TotpSetupDetails,
  UserExistsResult,
} from '../types';

// ---------------------------------------------------------------------------
// Memberships endpoint wire shape.
//
// Mirrors `GET {developerApiBase}/developer/memberships` one-to-one
// (DeveloperMembershipsHandler.TenantMembership). The backend returns a BARE
// JSON array; every field is REQUIRED there, so the optional markers + the
// fallbacks in mapMembership() are defensive only (tolerate partial/legacy
// rows without dropping a membership the user really has).
// ---------------------------------------------------------------------------
interface MembershipWire {
  readonly tenantId: string;
  readonly tenantName?: string;
  readonly tenantKind?: 'live' | 'test';
  readonly role?: 'OWNER' | 'SUB_USER';
  readonly status?: 'ACTIVE' | 'PENDING' | 'SUSPENDED';
  readonly partnerId?: string;
}

// Wire shape of one row from `GET {developerApiBase}/developer/app-contexts`
// (a `{ data: [...], nextCursor }` page of AppContextResponse). Only the fields
// the switcher needs; all optional/defensive.
interface AppContextWire {
  readonly contextId?: string;
  readonly name?: string;
  readonly status?: string;
}

// ---------------------------------------------------------------------------
// Error mapping — translate Amplify error names to AuthError codes so the
// rest of the app can pattern-match on provider-agnostic codes.
//
// IMPORTANT: NotAuthorizedException ("Incorrect username or password.") and
// UserNotFoundException both map to INVALID_CREDENTIALS — collapsing them
// is a deliberate user-enumeration defense.
// ---------------------------------------------------------------------------

function mapAmplifyError(e: unknown): Error {
  // Pass through anything already normalized (don't re-wrap).
  if (e instanceof AuthError) return e;

  if (!(e instanceof Error)) {
    return new AuthError('UNKNOWN', 'An unexpected error occurred.');
  }

  switch (e.name) {
    case 'NotAuthorizedException':
    case 'UserNotFoundException':
      return new AuthError('INVALID_CREDENTIALS', e.message);
    case 'UserNotConfirmedException':
      return new AuthError('USER_NOT_CONFIRMED', e.message);
    case 'CodeMismatchException':
      return new AuthError('CODE_MISMATCH', e.message);
    case 'ExpiredCodeException':
      return new AuthError('EXPIRED_CODE', e.message);
    case 'InvalidPasswordException':
      return new AuthError('PASSWORD_POLICY_VIOLATION', e.message);
    case 'LimitExceededException':
    case 'TooManyRequestsException':
    case 'TooManyFailedAttemptsException':
      return new AuthError('LIMIT_EXCEEDED', e.message);
    case 'NetworkError':
      return new AuthError('NETWORK_ERROR', e.message);
    default:
      return new AuthError('UNKNOWN', e.message);
  }
}

/**
 * Wraps an Amplify call so any thrown error is mapped to AuthError before
 * propagating. Keeps each adapter method tight + ensures we never leak
 * Amplify-specific error names to consumers.
 */
async function tryAmplify<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw mapAmplifyError(e);
  }
}

/**
 * Whether a signIn error reflects a LINGERING LOCAL SESSION rather than bad
 * input — either a user is still "signed in" locally, or the stored token was
 * revoked out-of-band (e.g. a global sign-out in a sibling app on the same user
 * pool). Both wedge a fresh login until the stale session is cleared. Detected
 * from the RAW Amplify error (before mapping): the name is reliable for the
 * already-authenticated case; the revoked case shares `NotAuthorizedException`
 * with bad credentials, so it's distinguished by message.
 */
function isLingeringSessionError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.name === 'UserAlreadyAuthenticatedException') return true;
  // The revoked case shares NotAuthorizedException with bad credentials, so it's
  // distinguished by message. This keys on Amplify's English string — if that
  // ever changes, the self-heal simply stops engaging (login wedges as it did
  // before this fix); it never misclassifies a failure as success.
  return e.name === 'NotAuthorizedException' && /revoked/i.test(e.message);
}

/**
 * Map a Cognito/Amplify MFA-type string onto our normalized {@link MfaMethod},
 * or null for anything we don't model. Amplify v6 emits `'TOTP' | 'SMS' | 'EMAIL'`
 * from fetchMFAPreference(); the explicit allow-list means a future Amplify
 * addition is ignored rather than leaking an unknown string into the UI.
 */
function mapCognitoMfaType(type: string): MfaMethod | null {
  switch (type) {
    case 'TOTP':
      return 'TOTP';
    case 'SMS':
      return 'SMS';
    case 'EMAIL':
      return 'EMAIL';
    default:
      return null;
  }
}

/**
 * Deployment-specific configuration the Cognito provider needs, injected by the
 * host app rather than hard-coded in the library (so a fork points it at its own
 * deployment).
 *
 * - `developerApiBase` — base URL of the Cognito-gated developer API the provider
 *   calls to resolve memberships and mint partner-API tokens
 *   (e.g. `https://api.staging.vectros.ai`).
 * - `productName` — human-facing product name used as the TOTP issuer label shown
 *   in authenticator apps (e.g. "Vectros Admin").
 *
 * The Cognito user-pool / client IDs are configured separately by the host app via
 * `Amplify.configure(...)`; the provider reads them from Amplify's ambient config,
 * so they are not part of this object.
 */
export interface CognitoAuthProviderConfig {
  readonly developerApiBase: string;
  readonly productName: string;
}

/**
 * Concrete AuthProviderAdapter backed by AWS Cognito via aws-amplify v6.
 */
export class CognitoAuthProvider implements AuthProviderAdapter {
  /**
   * Deployment-specific configuration injected by the host app — see
   * {@link CognitoAuthProviderConfig}. To swap Cognito for another provider in a
   * fork, implement {@link AuthProviderAdapter} directly instead of constructing
   * this class.
   */
  constructor(private readonly config: CognitoAuthProviderConfig) {}

  /**
   * Memoized memberships, used only to resolve a tenantId → its env mode for
   * {@link mintPartnerApiToken}. Stable for a session (a tenant's env mode
   * doesn't change); cleared on signOut so a new identity never reads the
   * previous user's mapping.
   */
  private cachedMemberships: ReadonlyArray<TenantMembership> | null = null;

  async getCurrentUser(): Promise<AuthUser | null> {
    try {
      // amplifyGetCurrentUser() throws if no session exists — we treat that
      // as "not signed in" and return null. The contract requires no-throw
      // on the no-session case.
      await amplifyGetCurrentUser();
      const attrs = await fetchUserAttributes();
      return this.attributesToUser(attrs);
    } catch {
      return null;
    }
  }

  async signIn(input: SignInInput): Promise<SignInResult> {
    const credentials = {
      username: input.email.toLowerCase(),
      password: input.password,
    };
    try {
      const result = await amplifySignIn(credentials);
      return this.mapSignInStep(result.nextStep);
    } catch (e) {
      // A lingering local session (already signed in, or a revoked/stale token
      // from a global sign-out in a sibling app on the same user pool) wedges a
      // fresh login. Clear it and retry once so the user can always sign back in
      // rather than getting stuck. Any other error maps + propagates as usual.
      if (!isLingeringSessionError(e)) throw mapAmplifyError(e);
      await this.signOut().catch(() => undefined); // best-effort local clear
      const result = await tryAmplify(() => amplifySignIn(credentials));
      return this.mapSignInStep(result.nextStep);
    }
  }

  async confirmSignIn(input: ConfirmSignInInput): Promise<SignInResult> {
    const result = await tryAmplify(() =>
      amplifyConfirmSignIn({
        challengeResponse: input.challengeResponse,
      }),
    );
    return this.mapSignInStep(result.nextStep);
  }

  async signUp(input: SignUpInput): Promise<SignUpResult> {
    const userAttributes: Record<string, string> = {
      email: input.email.toLowerCase(),
      given_name: input.firstName,
      family_name: input.lastName,
    };
    // Translate provider-agnostic metadata to Cognito's custom-attribute
    // namespace. Cognito requires the `custom:` prefix for any attribute
    // not in its standard OIDC set (email, given_name, etc.).
    if (input.metadata) {
      for (const [key, value] of Object.entries(input.metadata)) {
        userAttributes[`custom:${key}`] = value;
      }
    }
    const result = await tryAmplify(() =>
      amplifySignUp({
        username: input.email.toLowerCase(),
        password: input.password,
        options: { userAttributes },
      }),
    );
    if (result.nextStep.signUpStep === 'DONE') {
      return { kind: 'COMPLETE' };
    }
    return { kind: 'CONFIRMATION_REQUIRED', method: 'CODE' };
  }

  async confirmSignUp(input: ConfirmSignUpInput): Promise<void> {
    await tryAmplify(() =>
      amplifyConfirmSignUp({
        username: input.email.toLowerCase(),
        confirmationCode: input.code,
      }),
    );
  }

  async resendSignUpCode(input: { email: string }): Promise<void> {
    await tryAmplify(() =>
      amplifyResendSignUpCode({
        username: input.email.toLowerCase(),
      }),
    );
  }

  async forgotPassword(input: ForgotPasswordInput): Promise<void> {
    await tryAmplify(() => resetPassword({ username: input.email.toLowerCase() }));
  }

  async confirmForgotPassword(input: ConfirmForgotPasswordInput): Promise<void> {
    await tryAmplify(() =>
      confirmResetPassword({
        username: input.email.toLowerCase(),
        confirmationCode: input.code,
        newPassword: input.newPassword,
      }),
    );
  }

  async changePassword(input: ChangePasswordInput): Promise<void> {
    await tryAmplify(() =>
      updatePassword({
        oldPassword: input.oldPassword,
        newPassword: input.newPassword,
      }),
    );
  }

  async signOut(): Promise<void> {
    // Drop the per-session memberships memo so the next identity doesn't read
    // the previous user's tenantId→env mapping in mintPartnerApiToken.
    this.cachedMemberships = null;
    // Global sign-out invalidates refresh tokens across all of the user's
    // sessions. See module header for the threat-model rationale.
    await tryAmplify(() => amplifySignOut({ global: true }));
  }

  async getIdToken(): Promise<string | null> {
    const { tokens } = await tryAmplify(() => fetchAuthSession());
    return tokens?.idToken?.toString() ?? null;
  }

  // ------------------------------------------------------------------------
  // Multi-tenancy. The Cognito reference implementation:
  //   - active tenant lives in the `active_tenant` JWT claim (Pre-Token
  //     Generation Lambda);
  //   - switching POSTs the developer API + force-refreshes the session so
  //     the next request carries the updated claim;
  //   - memberships come from the developer-API memberships endpoint.
  // ------------------------------------------------------------------------

  async getMemberships(): Promise<ReadonlyArray<TenantMembership>> {
    const idToken = await this.getIdToken();
    if (!idToken) return [];

    const resp = await fetch(`${this.config.developerApiBase}/developer/memberships`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!resp.ok) {
      // No session / no memberships → empty list, never throw (contract).
      if (resp.status === 401 || resp.status === 403 || resp.status === 404) return [];
      const body = await resp.text().catch(() => '');
      throw new AuthError('UNKNOWN', `Failed to load memberships: ${resp.status} ${body}`);
    }
    // Backend returns a BARE array; tolerate a { memberships: [...] } envelope
    // defensively. Typed as unknown to sidestep Array.isArray's flaky union
    // narrowing over a readonly-array member.
    const json: unknown = await resp.json().catch(() => null);
    let rows: ReadonlyArray<MembershipWire> = [];
    if (Array.isArray(json)) {
      rows = json as ReadonlyArray<MembershipWire>;
    } else if (json && typeof json === 'object') {
      const envelope = (json as { memberships?: unknown }).memberships;
      if (Array.isArray(envelope)) rows = envelope as ReadonlyArray<MembershipWire>;
    }
    return rows.map((r) => this.mapMembership(r));
  }

  async getActiveTenant(): Promise<TenantId | null> {
    const idToken = await this.getIdToken();
    if (!idToken) return null;
    try {
      // decodeJwt does NOT verify — intentional. This is our own session
      // token, already validated by Amplify; we only read a claim from it.
      const claims = decodeJwt(idToken);
      const tenant = claims['active_tenant'];
      return typeof tenant === 'string' && tenant.length > 0 ? tenant : null;
    } catch {
      // Malformed token (shouldn't happen for our own session) — the contract
      // says return null rather than throw.
      return null;
    }
  }

  async getActivePartnerUserId(): Promise<string | null> {
    const idToken = await this.getIdToken();
    if (!idToken) return null;
    try {
      // decodeJwt does NOT verify — intentional, same as getActiveTenant: this
      // is our own session token (already validated by Amplify); we only read a
      // claim. `active_partner_user_id` is injected by the Pre-Token Generation
      // Lambda for the active membership and follows tenant switches.
      const claims = decodeJwt(idToken);
      const id = claims['active_partner_user_id'];
      return typeof id === 'string' && id.length > 0 ? id : null;
    } catch {
      // Malformed token (shouldn't happen for our own session) — return null
      // rather than throw (contract parity with getActiveTenant).
      return null;
    }
  }

  async setActiveTenant(tenantId: TenantId): Promise<void> {
    const idToken = await this.getIdToken();
    if (!idToken) {
      throw new AuthError('INVALID_CREDENTIALS', 'Not authenticated — cannot switch tenant.');
    }
    const resp = await fetch(`${this.config.developerApiBase}/developer/active-tenant`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new AuthError('UNKNOWN', `Failed to switch active tenant: ${resp.status} ${body}`);
    }
    // DeveloperActiveTenantHandler returns { tenantId, requiresJwtRefresh,
    // message }. requiresJwtRefresh is false on a no-op switch (the requested
    // tenant was already active).
    const result = (await resp.json().catch(() => ({}))) as {
      readonly requiresJwtRefresh?: boolean;
    };
    if (result.requiresJwtRefresh) {
      // Re-mint tokens so the next request carries the new active_tenant /
      // active_partner_user_id claims the Pre-Token Lambda injects.
      await tryAmplify(() => fetchAuthSession({ forceRefresh: true }));
    }
  }

  async checkUserExists(email: string): Promise<UserExistsResult> {
    const target = email.toLowerCase();
    // If there's a session we KNOW that identity exists; compare it to the
    // target to drive AcceptPage's auto-link vs. wrong-identity branches.
    const current = await this.getCurrentUser();
    if (current) {
      const isMe = current.email.toLowerCase() === target;
      // When signed in as someone else we can't (client-side, without leaking
      // user-enumeration) prove whether the TARGET exists — but AcceptPage's
      // "different identity" branch only needs isMe=false, so report exists=isMe.
      return { exists: isMe, isMe };
    }
    // No active session. Proving whether `email` already has an identity needs
    // a privileged Cognito lookup (AdminGetUser) that's unsafe to expose to the
    // browser, and no developer-API existence endpoint exists yet. Degrade to
    // the historical behavior: report not-exists so AcceptPage takes the signUp
    // path; if the user DOES exist, signUp surfaces the provider's
    // UsernameExists error (visible, no orphan rows). Wire a backend existence
    // endpoint here to light up the "sign in to link" UX.
    return { exists: false, isMe: false };
  }

  async linkInvitation(inviteToken: string): Promise<LinkInvitationResult> {
    const idToken = await this.getIdToken();
    if (!idToken) {
      throw new AuthError(
        'INVALID_CREDENTIALS',
        'Not authenticated — sign in before linking an invitation.',
      );
    }
    const resp = await fetch(`${this.config.developerApiBase}/developer/link-invitation`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      // Backend body field is snake_case `invite_token` (DeveloperLinkInvitationHandler).
      body: JSON.stringify({ invite_token: inviteToken }),
    });
    if (!resp.ok) {
      // The backend returns a single uniform 400 for every unusable-invite
      // case (bad/expired token, email mismatch, already-a-member) — no
      // probing channel. Surface its message.
      const body = await resp.text().catch(() => '');
      throw new AuthError('UNKNOWN', `Failed to link invitation: ${resp.status} ${body}`);
    }
    const data = (await resp.json()) as {
      readonly tenantId: string;
      readonly partnerUserId: string;
      readonly role?: 'OWNER' | 'SUB_USER';
      readonly alreadyActive?: boolean;
    };
    return {
      tenantId: data.tenantId,
      partnerUserId: data.partnerUserId,
      role: data.role ?? 'SUB_USER',
      alreadyActive: data.alreadyActive ?? false,
    };
  }

  /**
   * Mint a short-lived partner-API bearer (st_*) scoped to `tenantId`. The
   * Admin App authenticates to the partner API (/v1/*) with THIS, not the
   * Cognito id token. Returns the token + its expiry (epoch ms).
   *
   * NOT part of AuthProviderAdapter: this is the Vectros-specific partner-API
   * bridge (it mints via the developer API's scoped-token endpoint, whose
   * `tenant=live|test` param is derived from the tenant's membership kind).
   * The host app wires it into the token cache via setPartnerApiTokenMinter; a
   * partner fork swaps the provider + wires its own minter. Keeping the
   * /developer/* call HERE (not in the shared cache) keeps the reference apps
   * forkable.
   *
   * `contextId` (optional): when supplied, the mint requests a token whose
   * `context_id` claim is that AppContext (the data-plane context switcher —
   * app.vectros.ai). The server validates the caller's access to it and 404s
   * uniformly otherwise (the per-context mint). Omitted →
   * tenant-default context (admin-app's control-plane behavior). Until the
   * backend per-context mint ships, the param is accepted by the endpoint
   * but resolves to the default context.
   */
  async mintPartnerApiToken(
    tenantId: TenantId,
    contextId?: string,
  ): Promise<{ token: string; expiresAtMs: number }> {
    const idToken = await this.getIdToken();
    if (!idToken) {
      throw new AuthError('INVALID_CREDENTIALS', 'Not authenticated — cannot mint a partner-API token.');
    }
    const kind = await this.resolveTenantKind(tenantId);
    const contextParam = contextId ? `&context=${encodeURIComponent(contextId)}` : '';
    const url =
      `${this.config.developerApiBase}/developer/scoped-token` +
      `?tenant=${encodeURIComponent(kind)}&ttl=900${contextParam}`;
    const resp = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new AuthError('UNKNOWN', `Partner-API token mint failed: ${resp.status} ${body}`);
    }
    const { token, expiresAt } = (await resp.json()) as {
      readonly token: string;
      readonly expiresAt: number;
    };
    return { token, expiresAtMs: expiresAt * 1000 }; // backend returns epoch seconds
  }

  /**
   * List the app contexts the OWNER can reach in `tenantId`. Reads the
   * OWNER-gated developer-API enumeration (`GET /developer/app-contexts?tenant=
   * <live|test>`) — NOT the partner data API, whose `listAppContexts` confines a
   * context-scoped token to its own context (so it can't enumerate siblings).
   * The `tenant` kind is derived from the membership, mirroring the scoped-token
   * mint. Paginates fully; returns [] on no-session / not-an-owner (403/404).
   *
   * `options.onlyMine` adds `mine=true`, which narrows the enumeration to the
   * contexts the caller holds an active access profile in (their provisioned
   * contexts) instead of the full tenant set — the data-plane switcher's view.
   */
  async listAppContexts(
    tenantId: TenantId,
    options?: ListAppContextsOptions,
  ): Promise<ReadonlyArray<AppContextSummary>> {
    const idToken = await this.getIdToken();
    if (!idToken) return [];
    const kind = await this.resolveTenantKind(tenantId);

    const out: AppContextSummary[] = [];
    let startFrom: string | undefined;
    // Safety ceiling (50 × 100 = 5000) — guards a non-advancing cursor.
    for (let page = 0; page < 50; page++) {
      const qs = new URLSearchParams({ tenant: kind, limit: '100' });
      if (options?.onlyMine) qs.set('mine', 'true');
      if (startFrom) qs.set('startFrom', startFrom);
      const resp = await fetch(
        `${this.config.developerApiBase}/developer/app-contexts?${qs.toString()}`,
        { headers: { Authorization: `Bearer ${idToken}` } },
      );
      if (!resp.ok) {
        // No session / not an owner / nothing configured → empty, never throw.
        if (resp.status === 401 || resp.status === 403 || resp.status === 404) return out;
        const body = await resp.text().catch(() => '');
        throw new AuthError('UNKNOWN', `Failed to list app contexts: ${resp.status} ${body}`);
      }
      const json = (await resp.json().catch(() => null)) as {
        readonly data?: ReadonlyArray<AppContextWire>;
        readonly nextCursor?: string | null;
      } | null;
      for (const r of json?.data ?? []) {
        if (r.contextId) {
          out.push({
            contextId: r.contextId,
            name: r.name && r.name.length > 0 ? r.name : r.contextId,
            ...(r.status ? { status: r.status } : {}),
          });
        }
      }
      const next = json?.nextCursor ?? null;
      if (!next) break;
      startFrom = next;
    }
    return out;
  }

  // ------------------------------------------------------------------------
  // Multi-factor auth — TOTP enrollment + management. All Amplify
  // MFA calls live here so the rest of the app sees only the adapter contract.
  // ------------------------------------------------------------------------

  async getMfaStatus(): Promise<MfaStatus> {
    return tryAmplify(async () => {
      const pref = await fetchMFAPreference();
      const enabled = (pref.enabled ?? [])
        .map((m) => mapCognitoMfaType(m))
        .filter((m): m is MfaMethod => m !== null);
      const preferred = pref.preferred ? mapCognitoMfaType(pref.preferred) : null;
      return { enabled, preferred };
    });
  }

  async setUpTotp(): Promise<TotpSetupDetails> {
    return tryAmplify(async () => {
      const details = await amplifySetUpTOTP();
      // accountName is what shows in the authenticator-app entry; use the
      // signed-in email so a user with several accounts can tell them apart.
      const current = await this.getCurrentUser();
      const accountName = current?.email ?? this.config.productName;
      const uri = details.getSetupUri(this.config.productName, accountName);
      return { secret: details.sharedSecret, otpauthUri: uri.toString() };
    });
  }

  async verifyTotpSetup(code: string): Promise<void> {
    await tryAmplify(async () => {
      // Prove possession of the secret, THEN make TOTP the preferred method —
      // verifyTOTPSetup alone registers the device but doesn't enable MFA.
      await verifyTOTPSetup({ code });
      await updateMFAPreference({ totp: 'PREFERRED' });
    });
  }

  async disableTotp(): Promise<void> {
    await tryAmplify(() => updateMFAPreference({ totp: 'DISABLED' }));
  }

  // ------------------------------------------------------------------------
  // Private mapping helpers — keep all Amplify-specific knowledge isolated.
  // ------------------------------------------------------------------------

  /**
   * Resolve a tenantId to its env mode ('live'|'test') for the scoped-token
   * mint. Reads from the memoized memberships, fetching once if absent. Defaults
   * to 'live' if the id isn't found (safer than 'test' for a tenant the user
   * holds an active membership in; a not-found id is a caller bug anyway).
   */
  private async resolveTenantKind(tenantId: TenantId): Promise<'live' | 'test'> {
    if (!this.cachedMemberships) {
      this.cachedMemberships = await this.getMemberships();
    }
    const match = this.cachedMemberships.find((m) => m.tenantId === tenantId);
    return match?.tenantKind === 'test' ? 'test' : 'live';
  }

  /** Map a memberships-endpoint row onto our normalized TenantMembership. */
  private mapMembership(r: MembershipWire): TenantMembership {
    return {
      tenantId: r.tenantId,
      // Fallbacks are defensive only — the backend supplies all fields. Name
      // falls back to the id; kind/role/status to the safe defaults the
      // backend itself uses for legacy/oddity rows.
      tenantName: r.tenantName ?? r.tenantId,
      tenantKind: r.tenantKind ?? 'live',
      role: r.role ?? 'SUB_USER',
      status: r.status ?? 'ACTIVE',
      partnerId: r.partnerId ?? '',
    };
  }

  private attributesToUser(attrs: Readonly<Record<string, string | undefined>>): AuthUser | null {
    const email = attrs['email'];
    const sub = attrs['sub'];
    if (!email || !sub) return null;
    return {
      sub,
      email,
      firstName: attrs['given_name'] ?? null,
      lastName: attrs['family_name'] ?? null,
    };
  }

  /**
   * Maps Amplify's `signInStep` string onto our SignInResult union. Unknown
   * step values throw `AuthError('UNKNOWN', detailed message)` — silent
   * fall-through on a new Amplify version is a real-world security risk
   * (an unrecognized challenge that we treated as "done" would let a half-
   * authenticated session proceed).
   *
   * Using AuthError (rather than a raw Error) keeps the contract consistent:
   * pages dispatch on `error.code`, and the diagnostic message survives in
   * `error.message` for developer debugging.
   */
  private mapSignInStep(nextStep: SignInNextStep): SignInResult {
    switch (nextStep.signInStep) {
      case 'DONE':
        return { kind: 'COMPLETE' };
      case 'CONFIRM_SIGN_UP':
        return { kind: 'CONFIRMATION_REQUIRED' };
      case 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED':
        return { kind: 'NEW_PASSWORD_REQUIRED' };
      case 'CONFIRM_SIGN_IN_WITH_TOTP_CODE':
        return { kind: 'MFA_REQUIRED', methods: ['TOTP'] };
      case 'CONFIRM_SIGN_IN_WITH_SMS_CODE':
        return { kind: 'MFA_REQUIRED', methods: ['SMS'] };
      case 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE':
        return { kind: 'MFA_REQUIRED', methods: ['EMAIL'] };
      case 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION': {
        // Prefer the REAL list Amplify surfaces (avoids a hardcoded
        // ['TOTP','SMS']); fall back to the common pool config only
        // if the SDK didn't populate it on this step.
        const methods = (nextStep.allowedMFATypes ?? [])
          .map((m) => mapCognitoMfaType(m))
          .filter((m): m is MfaMethod => m !== null);
        return { kind: 'MFA_REQUIRED', methods: methods.length > 0 ? methods : ['TOTP', 'SMS'] };
      }
      case 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP': {
        // Forced enrollment at login (pool REQUIRED, no device). The setup
        // details ride on the challenge — the UI renders the wizard inline and
        // completes via confirmSignIn. (Does not occur under OPTIONAL config.)
        const details = nextStep.totpSetupDetails;
        if (details) {
          return {
            kind: 'TOTP_SETUP_REQUIRED',
            setup: {
              secret: details.sharedSecret,
              otpauthUri: details.getSetupUri(this.config.productName).toString(),
            },
          };
        }
        // Missing details (shouldn't happen) — degrade to a TOTP code prompt.
        return { kind: 'MFA_REQUIRED', methods: ['TOTP'] };
      }
      default:
        throw new AuthError(
          'UNKNOWN',
          `CognitoAuthProvider: unrecognized sign-in step "${nextStep.signInStep}". ` +
            `This may indicate an Amplify version update introduced a new ` +
            `challenge type; map it explicitly in mapSignInStep().`,
        );
    }
  }
}

/**
 * Structural shape of the bits of Amplify's `nextStep` that mapSignInStep reads.
 * Amplify's own type is a per-step discriminated union; this captures the
 * common `signInStep` plus the two optional payloads we consume, so the helper
 * can read them without leaking Amplify's types past this file.
 */
interface SignInNextStep {
  readonly signInStep: string;
  readonly allowedMFATypes?: readonly string[];
  readonly totpSetupDetails?: {
    readonly sharedSecret: string;
    readonly getSetupUri: (appName: string, accountName?: string) => URL;
  };
}
