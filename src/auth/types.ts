// ---------------------------------------------------------------------------
// Auth-provider-agnostic types.
//
// The Admin App's UI depends on this file ONLY — never on aws-amplify, the
// AWS SDK, or any other identity-provider package. Concrete providers
// (CognitoAuthProvider, hypothetical Auth0AuthProvider, etc.) live in
// src/auth/providers/ and implement the AuthProviderAdapter contract below.
//
// To swap auth providers in a fork:
//   1. Write a new class implementing AuthProviderAdapter.
//   2. Replace the `new CognitoAuthProvider()` instantiation in main.tsx.
//   3. Delete src/auth/providers/cognito.ts (or keep alongside if your
//      fork supports multiple identity providers).
//
// Nothing else in the codebase needs to change.
// ---------------------------------------------------------------------------

/**
 * The signed-in user, normalized across providers. Concrete providers map
 * their native user shape (Cognito attributes, Auth0 user object, etc.) to
 * this interface in `getCurrentUser()`.
 */
export interface AuthUser {
  /** RFC 7519 `sub` — the immutable user identifier from the auth provider. */
  readonly sub: string;
  /** Verified email address. */
  readonly email: string;
  /** Given name (first name), or null if not supplied. */
  readonly firstName: string | null;
  /** Family name (last name), or null if not supplied. */
  readonly lastName: string | null;
}

/** Supported MFA challenge methods. Extend as providers add new methods. */
export type MfaMethod = 'TOTP' | 'SMS' | 'EMAIL';

/**
 * A user's current MFA configuration, provider-normalized. Returned by
 * {@link AuthProviderAdapter.getMfaStatus} and rendered by the /account 2FA
 * management card.
 */
export interface MfaStatus {
  /** Methods currently active for the user (empty = no MFA enrolled). */
  readonly enabled: ReadonlyArray<MfaMethod>;
  /** The default method Cognito will challenge with, or null if none. */
  readonly preferred: MfaMethod | null;
}

/**
 * Everything the UI needs to render a TOTP enrollment screen. Returned by
 * {@link AuthProviderAdapter.setUpTotp}. The `otpauthUri` is rendered as a QR
 * code; `secret` is the manual-entry fallback. NEITHER must ever leave the
 * browser (the secret is the shared TOTP key) — render the QR client-side.
 */
export interface TotpSetupDetails {
  /** Base32 shared secret, for manual entry into an authenticator app. */
  readonly secret: string;
  /** `otpauth://totp/...` provisioning URI to render as a QR code. */
  readonly otpauthUri: string;
}

// ---------------------------------------------------------------------------
// Multi-tenancy.
// ---------------------------------------------------------------------------

/**
 * An opaque tenant identifier — the real platform tenant UUID.
 *
 * NOTE the deliberate move away from an earlier `'live' | 'test'` env-string
 * shim: a tenant is now identified by its platform id, and the live/test
 * distinction (where it still matters — e.g. minting a partner-API token) is
 * carried separately on {@link TenantMembership.tenantKind}. Single-partner
 * Dev Admins still have exactly two memberships (their live + test tenants);
 * multi-partner sub-users have one membership per tenant they belong to.
 */
export type TenantId = string;

/**
 * A tenant the signed-in user is a member of. Returned by
 * {@link VectrosTenancyProvider.getMemberships}. The TenantSwitcher renders one
 * entry per membership; pages scope their data reads to the active one.
 *
 * Field shape mirrors the `GET /developer/memberships` response one-to-one
 * (DeveloperMembershipsHandler.TenantMembership) so the adapter mapping is
 * trivial. Multi-membership users (e.g. a sub-user of two partners) get one
 * entry per tenant, distinguished by `partnerId`.
 */
export interface TenantMembership {
  /** The opaque platform tenant id (real UUID). */
  readonly tenantId: TenantId;
  /** Human-readable switcher label, e.g. "Acme (Live)" (backend-synthesized). */
  readonly tenantName: string;
  /**
   * Env mode of the tenant. Also the axis used when minting a partner-API
   * token (maps to the developer API's `tenant=live|test` param).
   */
  readonly tenantKind: 'live' | 'test';
  /** The caller's role within this tenant. OWNER implies wildcard scope. */
  readonly role: 'OWNER' | 'SUB_USER';
  /** Status of the caller's membership row. */
  readonly status: 'ACTIVE' | 'PENDING' | 'SUSPENDED';
  /** The partner the tenant belongs to — distinguishes cross-partner memberships. */
  readonly partnerId: string;
}

/**
 * Result of {@link AuthProviderAdapter.checkUserExists}. Powers AcceptPage's
 * signUp-vs-link pivot:
 *   - `!exists`           → first-time signup flow.
 *   - `exists && isMe`    → auto-link (the invite is for the current session).
 *   - `exists && !isMe`   → sign-out-and-retry (identity-confusion guard).
 */
export interface UserExistsResult {
  /** An identity for this email already exists with the provider. */
  readonly exists: boolean;
  /** That existing identity is the currently-signed-in session. */
  readonly isMe: boolean;
}

/**
 * Result of {@link AuthProviderAdapter.linkInvitation} — the new membership the
 * invite was linked onto. `alreadyActive` is true on an idempotent replay (the
 * invite was already linked), so callers can avoid double-toasting "added!".
 */
export interface LinkInvitationResult {
  readonly tenantId: TenantId;
  readonly partnerUserId: string;
  readonly role: 'OWNER' | 'SUB_USER';
  readonly alreadyActive: boolean;
}

export interface SignInInput {
  readonly email: string;
  readonly password: string;
}

/**
 * Discriminated union representing what the UI must do next after sign-in.
 * Concrete providers translate their native challenge model (Cognito's
 * `nextStep.signInStep`, Auth0's MFA grant flow, etc.) into this shape.
 */
export type SignInResult =
  /** Sign-in is complete. User session is established. */
  | { readonly kind: 'COMPLETE' }
  /** MFA challenge active. UI should prompt for the appropriate code. */
  | { readonly kind: 'MFA_REQUIRED'; readonly methods: ReadonlyArray<MfaMethod> }
  /** First-login forced password change required. */
  | { readonly kind: 'NEW_PASSWORD_REQUIRED' }
  /**
   * Forced TOTP enrollment AT sign-in (pool MFA is REQUIRED and the user has no
   * authenticator device yet). The UI renders the enrollment wizard INLINE in
   * the login flow — it must NOT redirect to a protected route, since the user
   * isn't authenticated yet — and completes via `confirmSignIn({ challengeResponse: code })`.
   * `setup` comes straight off the provider's sign-in challenge, not a separate
   * setUpTotp() call.
   */
  | { readonly kind: 'TOTP_SETUP_REQUIRED'; readonly setup: TotpSetupDetails }
  /** Email not yet confirmed (signup incomplete). UI should redirect to confirm flow. */
  | { readonly kind: 'CONFIRMATION_REQUIRED' };

export interface ConfirmSignInInput {
  /** The code or response the user provided to the active challenge. */
  readonly challengeResponse: string;
}

export interface SignUpInput {
  readonly email: string;
  readonly password: string;
  readonly firstName: string;
  readonly lastName: string;
  /**
   * Provider-agnostic bag for additional signup metadata. Concrete providers
   * translate to their native attribute system:
   *   - CognitoAuthProvider maps each key to `custom:<key>` (Cognito's
   *     required prefix for app-defined attributes).
   *   - An Auth0 implementation would put these in `user_metadata`.
   *   - A custom backend might put them in a separate signup-extension call.
   * Values must be strings (the most-restrictive intersection across major
   * providers — Cognito custom attributes are string-only).
   */
  readonly metadata?: Readonly<Record<string, string>>;
}

/**
 * Discriminated union for the post-signup state. CONFIRMATION_REQUIRED is
 * the common case for email/password providers; COMPLETE is for providers
 * that don't require email verification (or have already verified via OAuth).
 */
export type SignUpResult =
  | { readonly kind: 'CONFIRMATION_REQUIRED'; readonly method: 'CODE' | 'LINK' }
  | { readonly kind: 'COMPLETE' };

export interface ConfirmSignUpInput {
  readonly email: string;
  readonly code: string;
}

export interface ForgotPasswordInput {
  readonly email: string;
}

export interface ConfirmForgotPasswordInput {
  readonly email: string;
  readonly code: string;
  readonly newPassword: string;
}

export interface ChangePasswordInput {
  readonly oldPassword: string;
  readonly newPassword: string;
}

/**
 * Shared implementation rules for EVERY interface below (core, embedded,
 * hosted-redirect, tenancy alike):
 *   - Email addresses are lower-cased before being passed to the underlying
 *     provider (case-folding is the caller's responsibility on input, but
 *     the adapter MUST not require the caller to pre-lowercase).
 *   - Return values are the normalized DTOs above — NEVER provider-native
 *     types. If the underlying provider returns an unknown challenge type,
 *     the adapter is responsible for either mapping it onto a known SignInResult
 *     variant or throwing a clear error.
 *   - Errors propagate as `AuthError` instances (see ./errors.ts) with a
 *     normalized `code: AuthErrorCode`. Provider adapters translate their
 *     SDK's native error vocabulary at the adapter boundary so consumer
 *     pages pattern-match only on `error.code`, never on provider-specific
 *     `error.name`. The adapter MUST not swallow errors.
 *   - All methods are async and idempotent where the underlying API allows.
 *
 * ---------------------------------------------------------------------------
 * WHY FOUR INTERFACES, NOT ONE — read this before adding a method to any of them.
 *
 * A provider's real capabilities split along two INDEPENDENT axes, not one
 * pile of "sometimes optional" methods:
 *
 *   1. Integration MODE — does the provider let the app drive the sign-in/
 *      signup/password/MFA ceremony (EmbeddedCredentialAuth), or does a
 *      provider-hosted page own the whole thing end to end
 *      (HostedRedirectAuth)? This is a real, named choice every major IdP
 *      (Cognito, Auth0, Okta) offers explicitly, and — critically — a
 *      HOSTED-REDIRECT provider cannot honestly implement ANY
 *      EmbeddedCredentialAuth method: signup, password reset, change-password,
 *      and MFA (both at sign-in and self-service management) all happen on
 *      the provider's own hosted pages under that mode, invisible to this
 *      app. There is no meaningful "optional, might work" middle ground here.
 *   2. Vectros's OWN multi-tenant developer-portal model
 *      (VectrosTenancyProvider) — membership listing/switching and the
 *      Cognito-shaped invite-linking dance. This is NOT an integration-mode
 *      question at all; it's specific to Vectros's Cognito-backed dev portal.
 *      A BYO-IdP fork using the token-exchange model
 *      (`POST /v1/auth/token/exchange`) can NEVER implement this — the
 *      exchange contract pins one registered issuer to exactly one
 *      `{tenantId, contextId}`, permanently, so there is no second tenant to
 *      discover or switch to. Not "unsupported yet" — structurally
 *      inapplicable to any exchange-based provider, by design.
 *
 * Each concrete provider implements exactly the interfaces that genuinely
 * apply — `CognitoAuthProvider implements AuthProviderAdapter,
 * EmbeddedCredentialAuth, VectrosTenancyProvider`; a hosted-redirect Auth0
 * provider implements `AuthProviderAdapter, HostedRedirectAuth` and nothing
 * else. No stub-throws, no flat optional methods scattered across one
 * 20+-method interface — a consumer that shouldn't call a method gets a
 * compile error, not a documented runtime throw.
 * ---------------------------------------------------------------------------
 */

/**
 * A reachable AppContext, as surfaced to the data-plane context switcher. A
 * provider-agnostic projection of whatever the backend's context model is — the
 * consumer composes the switcher option (tenant, kind, …) around it.
 */
export interface AppContextSummary {
  /** The context identifier (the `context_id` a data-plane token is scoped to). */
  readonly contextId: string;
  /** Human-readable display name (falls back to the contextId when absent). */
  readonly name: string;
  /** Lifecycle status (`active` under normal operation), when the backend reports it. */
  readonly status?: string;
}

/** Options for {@link VectrosTenancyProvider.listAppContexts}. */
export interface ListAppContextsOptions {
  /**
   * When true, return only the contexts the caller is actually provisioned in
   * (holds an active access profile), rather than the full tenant set — the
   * data-plane "show only contexts I'm provisioned in" view. Default false
   * preserves the full owner enumeration (e.g. a cross-context control plane).
   */
  readonly onlyMine?: boolean;
}

/**
 * The CORE contract — every provider, hosted or embedded, implements this and
 * only this unconditionally. Sign-in itself is deliberately NOT here: an
 * embedded provider's sign-in takes credentials and resolves synchronously
 * with a {@link SignInResult} (see {@link EmbeddedCredentialAuth.signIn}); a
 * hosted-redirect provider's sign-in takes no credentials, navigates the
 * whole page away, and can never resolve a result from the call that starts
 * it (see {@link HostedRedirectAuth.signInWithRedirect}) — those are two
 * genuinely different shapes, not one method two providers happen to
 * implement differently.
 */
export interface AuthProviderAdapter {
  /**
   * Returns the currently-signed-in user, or null if no active session.
   * Called once on app load by AuthContext + after sign-in to populate state.
   * MUST NOT throw on "no session" — return null instead.
   */
  getCurrentUser(): Promise<AuthUser | null>;

  /**
   * Signs the user out. Implementations SHOULD perform a global sign-out
   * (invalidate refresh tokens) when the underlying provider supports it,
   * to defend against stolen-refresh-token replay.
   */
  signOut(): Promise<void>;

  /**
   * Returns the current bearer token to attach to authenticated API calls,
   * or null if no active session. For OIDC providers this is the id_token;
   * for opaque-token providers this is whatever the API expects.
   */
  getIdToken(): Promise<string | null>;
}

/**
 * Embedded/credential-driven auth methods — sign-in, signup, password reset,
 * change-password, and BOTH MFA facets (challenge-at-sign-in via
 * {@link confirmSignIn} and self-service enrollment/management), all driven
 * synchronously by THIS app against the provider's SDK/API. A provider only
 * implements this when it genuinely lets an app build its own UI for all of
 * it — see the file-header note on why this can't be partial per method.
 * `CognitoAuthProvider` implements this in full.
 */
export interface EmbeddedCredentialAuth {
  signIn(input: SignInInput): Promise<SignInResult>;

  /**
   * Completes a sign-in challenge (MFA code, new password, etc.) using the
   * response the user provided. Returns the same SignInResult shape so the
   * caller can chain further challenges if the provider requires them.
   */
  confirmSignIn(input: ConfirmSignInInput): Promise<SignInResult>;

  signUp(input: SignUpInput): Promise<SignUpResult>;

  confirmSignUp(input: ConfirmSignUpInput): Promise<void>;

  resendSignUpCode(input: { readonly email: string }): Promise<void>;

  forgotPassword(input: ForgotPasswordInput): Promise<void>;

  confirmForgotPassword(input: ConfirmForgotPasswordInput): Promise<void>;

  changePassword(input: ChangePasswordInput): Promise<void>;

  /**
   * The user's current MFA configuration. MUST NOT throw on "no MFA enrolled"
   * — return `{ enabled: [], preferred: null }`.
   */
  getMfaStatus(): Promise<MfaStatus>;

  /**
   * Begin TOTP enrollment: provision a new (unconfirmed) authenticator secret
   * and return the QR/manual-entry details. Does NOT enable MFA — the user
   * must prove possession via {@link verifyTotpSetup} first.
   */
  setUpTotp(): Promise<TotpSetupDetails>;

  /**
   * Confirm TOTP enrollment with a code from the user's authenticator app, then
   * make TOTP the preferred method. Throws on an incorrect/expired code.
   */
  verifyTotpSetup(code: string): Promise<void>;

  /** Disable TOTP for the current user. Idempotent. */
  disableTotp(): Promise<void>;
}

/**
 * Hosted-redirect auth methods — a provider-hosted page owns the entire
 * sign-in/signup/password/MFA ceremony; this app only kicks the redirect off
 * and picks up the result afterward. `signIn` doesn't exist in this shape:
 * there is nothing to await a `SignInResult` from — the browser navigates
 * away mid-call. A Universal-Login-style Auth0 provider implements this
 * instead of {@link EmbeddedCredentialAuth}.
 */
export interface HostedRedirectAuth {
  /**
   * Kick off the provider's hosted sign-in page — a full top-level navigation
   * away from this app. Resolves (if at all) right before the browser
   * unloads; the actual outcome is observed later via
   * {@link handleRedirectCallback} on the return trip, not from this call's
   * own promise. `options.returnTo` is carried through opaquely (e.g. Auth0's
   * `appState`) and should be read back out by the caller (via its own
   * storage, not this interface) if it needs to restore the pre-redirect
   * location. SECURITY: nothing in this package validates `returnTo` — a
   * future caller that reads it back out MUST confirm it's a same-origin,
   * relative path before navigating to it (an unsanitized read-and-navigate
   * is an open redirect).
   */
  signInWithRedirect(options?: { readonly returnTo?: string }): Promise<void>;

  /**
   * Called once, from the app's redirect-callback route, after the provider
   * has navigated the user back with an authorization result in the URL.
   * Completes the code exchange and establishes the session; the caller
   * should follow up with {@link AuthProviderAdapter.getCurrentUser} (the
   * `<AuthProvider>` wiring does this automatically) rather than expect a
   * `SignInResult` back from here — there is no mid-flow challenge state to
   * report under this mode, only "did a session end up established."
   * Throws on a failed/cancelled/denied redirect.
   */
  handleRedirectCallback(): Promise<void>;

  /**
   * Bind a first-time signer to a PENDING invitation, completing a
   * Shape-1/Captive-Enterprise onboarding (no self-signup — every identity,
   * including the first admin, arrives via an invite). Call this ONCE, from
   * the app's own accept-invite route, AFTER {@link handleRedirectCallback}
   * has already established a real session for this call to present — the
   * invite token alone proves nothing; it's the (now-authenticated) caller's
   * verified email claim plus this token together that the platform's
   * token-exchange endpoint binds.
   *
   * Deliberately returns `void`, not a token: this call's job is ONLY to
   * perform the server-side bind (the caller's identity transitions from
   * PENDING to ACTIVE). It does not populate this package's partner-API
   * token cache — the next ordinary API call re-mints through the ordinary
   * (invite-token-free) path, which now succeeds because the bind already
   * happened. Throws on a bad/expired/already-used invite token, or an
   * email mismatch between the invite and the identity that signed in —
   * the platform's own uniform-not-found discipline collapses all of these
   * to one generic rejection; do not attempt to distinguish them client-side.
   */
  acceptInvite(inviteToken: string): Promise<void>;
}

/**
 * Vectros's own multi-tenant developer-portal model — membership
 * listing/switching, app-context enumeration, and the Cognito-shaped
 * invite-linking dance. NOT an integration-mode concern (see the file-header
 * note): a BYO-IdP fork using the token-exchange model can never implement
 * this at all, because the exchange contract pins one registered issuer to
 * exactly one `{tenantId, contextId}` permanently — there is no second tenant
 * to discover or switch to, ever, for any exchange-based provider. Only
 * `CognitoAuthProvider` implements this; consumers that need it
 * (`CurrentTenantProvider`) take it as an explicit prop, not through the
 * generic `useAuth()` surface.
 */
export interface VectrosTenancyProvider {
  /**
   * All tenant memberships the current user has. Returns an empty array when
   * the user has none (or no active session). MUST NOT throw on "no session".
   * The Cognito reference impl reads the platform's memberships endpoint;
   * other providers map their own membership source.
   */
  getMemberships(): Promise<ReadonlyArray<TenantMembership>>;

  /**
   * The currently-active tenant id, or null if the user has zero memberships.
   * For the Cognito impl this is the `active_tenant` claim injected by the
   * Pre-Token Generation Lambda.
   */
  getActiveTenant(): Promise<TenantId | null>;

  /**
   * The platform principal id of the current user WITHIN the active tenant —
   * the value that AccessProfiles are keyed by (a multi-tenant user has a
   * distinct principal per tenant). Returns `null` when there is no session.
   *
   * Provider-agnostic name, provider-specific source: the Cognito impl reads
   * the `active_partner_user_id` claim the Pre-Token Generation Lambda injects
   * alongside `active_tenant` (so it follows tenant switches), decoded from the
   * session token exactly as {@link getActiveTenant} does. This keeps JWT/claim
   * knowledge inside the adapter — consumers compose the full principal id
   * (e.g. `usr_<id>`) without knowing the IdP.
   *
   * Used by the data-plane context switcher to enumerate the AppContexts a
   * SUB_USER can reach (`listProfilesForPrincipal`).
   */
  getActivePartnerUserId(): Promise<string | null>;

  /**
   * Switch the active tenant. Implementations persist the choice server-side
   * AND trigger a token refresh so the next request carries the updated
   * active-tenant claim. Resolves once the refresh (if any) has completed.
   */
  setActiveTenant(tenantId: TenantId): Promise<void>;

  /**
   * Whether an identity for `email` already exists with this provider, and
   * whether it is the current session (`isMe`). Powers AcceptPage's
   * signUp-vs-link pivot for sub-user invitations. MUST NOT leak existence
   * via differentiated errors — return the flags, don't throw on "not found".
   */
  checkUserExists(email: string): Promise<UserExistsResult>;

  /**
   * Link a pending invitation to the CURRENT session's identity — the
   * "already have an account" accept path. Requires an active session (the
   * caller's identity is taken from it,
   * never from input). Idempotent: re-linking the same invite resolves with
   * `alreadyActive: true`. Throws on an invalid/unusable invitation.
   */
  linkInvitation(inviteToken: string): Promise<LinkInvitationResult>;

  /**
   * List the AppContexts the current user can reach in `tenantId` — the
   * data-plane context switcher's OWNER enumeration. Returns an empty array
   * when there are none / no session; MUST NOT throw on "no session".
   *
   * Optional: even within this Cognito-shaped interface, a fork that hasn't
   * wired app contexts can omit it, and the switcher degrades to no
   * owner-listed contexts. The Cognito reference impl reads the OWNER-gated
   * developer-API enumeration (a context-scoped data token deliberately
   * cannot list sibling contexts, so this is NOT the partner data API). The
   * `tenantId` is provider-agnostic — the impl maps it to its own backend
   * (the Cognito impl resolves it to the tenant's live/test kind).
   */
  listAppContexts?(
    tenantId: TenantId,
    options?: ListAppContextsOptions,
  ): Promise<ReadonlyArray<AppContextSummary>>;
}
