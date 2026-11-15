// ---------------------------------------------------------------------------
// ExpoAuthProvider: sign-in for a React Native (Expo) app through the
// tenant's own identity provider, implementing AuthProviderAdapter +
// HostedRedirectAuth. The identity provider must offer the OpenID Connect
// authorization-code flow with PKCE to a public client (Amazon Cognito with a
// user pool domain, Auth0, Okta, Microsoft Entra ID and most others do;
// Firebase Authentication does not).
//
// The flow:
//   1. `signInWithRedirect()` opens the identity provider's sign-in page in
//      the system browser (never a webview) with an authorization-code request
//      protected by PKCE, and trades the returned code for the provider's
//      tokens.
//   2. The provider's REFRESH token is kept in the device keychain or keystore
//      (`expo-secure-store`); the ID and access tokens are kept in memory only.
//      A relaunch restores the session from the refresh token without showing
//      a sign-in page.
//   3. `mintPartnerApiToken()` exchanges the provider's token for a short-lived
//      Vectros bearer (`POST /v1/auth/token/exchange`), refreshing the
//      provider's token first when it is about to expire. Wire it into the
//      shared token cache with `setPartnerApiTokenMinter`.
//
// The Expo modules are passed in rather than imported, so this package carries
// no dependency on Expo or React Native and the bundler never has to resolve
// one for a web app:
//
//   import * as AuthSession from 'expo-auth-session';
//   import * as SecureStore from 'expo-secure-store';
//
//   const auth = new ExpoAuthProvider({
//     issuer: 'https://idp.example.com',
//     clientId: 'my-public-client-id',
//     redirectUri: AuthSession.makeRedirectUri({ scheme: 'myapp' }),
//     subjectToken: 'id_token',
//     exchangeEndpoint: 'https://api.vectros.ai/v1/auth/token/exchange',
//     authSession: AuthSession,
//     secureStore: SecureStore,
//   });
//
// Like the Auth0 provider, it does not implement EmbeddedCredentialAuth (the
// identity provider's hosted pages own sign-up, password reset and MFA) or
// VectrosTenancyProvider (the issuer registration, not the app, decides the
// tenant).
// ---------------------------------------------------------------------------

import { AuthError } from '../errors';
import type { AuthProviderAdapter, AuthUser, HostedRedirectAuth } from '../types';
import { clearVectrosApiTokenCache } from '../vectrosApiTokenCache';
import { assertExchangeEndpoint, exchangeSubjectToken } from './tokenExchange';
import type { ExchangedToken, TokenExchangeOptions } from './tokenExchange';

// ---- The parts of the Expo modules this provider calls --------------------
//
// Structural types for the subset of `expo-auth-session` and
// `expo-secure-store` used here. The modules themselves satisfy them, so an
// app passes `import * as AuthSession from 'expo-auth-session'` as is.

/** The OpenID Connect endpoints this provider uses (a subset of `expo-auth-session`'s `DiscoveryDocument`). */
export interface ExpoDiscoveryDocument {
  readonly authorizationEndpoint?: string;
  readonly tokenEndpoint?: string;
  readonly revocationEndpoint?: string;
}

/** The fields of `expo-auth-session`'s `TokenResponse` this provider reads. */
export interface ExpoTokenResponse {
  readonly accessToken: string;
  readonly idToken?: string;
  readonly refreshToken?: string;
  /** Lifetime in seconds, when the identity provider states one. */
  readonly expiresIn?: number;
  /** Issue time in epoch SECONDS. */
  readonly issuedAt: number;
}

/** The result of `AuthRequest.promptAsync` (a subset of `expo-auth-session`'s `AuthSessionResult`). */
export type ExpoAuthSessionResult =
  | {
      readonly type: 'success' | 'error';
      readonly params: Record<string, string>;
      readonly error?: { readonly message: string } | null;
    }
  | { readonly type: 'cancel' | 'dismiss' | 'opened' | 'locked' };

/** The parts of `expo-auth-session`'s `AuthRequest` this provider uses. */
export interface ExpoAuthRequest {
  readonly codeVerifier?: string;
  promptAsync(discovery: ExpoDiscoveryDocument): Promise<ExpoAuthSessionResult>;
}

/** The functions of `expo-auth-session` this provider calls. */
export interface ExpoAuthSessionModule {
  readonly AuthRequest: new (config: {
    clientId: string;
    redirectUri: string;
    scopes?: string[];
    usePKCE?: boolean;
    extraParams?: Record<string, string>;
  }) => ExpoAuthRequest;
  fetchDiscoveryAsync(issuer: string): Promise<ExpoDiscoveryDocument>;
  exchangeCodeAsync(
    config: { clientId: string; code: string; redirectUri: string; extraParams?: Record<string, string> },
    discovery: ExpoDiscoveryDocument,
  ): Promise<ExpoTokenResponse>;
  refreshAsync(
    config: { clientId: string; refreshToken: string },
    discovery: ExpoDiscoveryDocument,
  ): Promise<ExpoTokenResponse>;
  revokeAsync(config: { clientId: string; token: string }, discovery: ExpoDiscoveryDocument): Promise<boolean>;
}

/** The `expo-secure-store` options this provider passes (a subset of its `SecureStoreOptions`). */
export interface ExpoSecureStoreOptions {
  readonly keychainAccessible?: number;
}

/** The functions of `expo-secure-store` this provider calls. */
export interface ExpoSecureStoreModule {
  getItemAsync(key: string, options?: ExpoSecureStoreOptions): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: ExpoSecureStoreOptions): Promise<void>;
  deleteItemAsync(key: string, options?: ExpoSecureStoreOptions): Promise<void>;
}

// ---- Configuration ---------------------------------------------------------

/**
 * Deployment-specific configuration, injected by the app.
 *
 * - `issuer`: the identity provider's OpenID Connect issuer URL. Its endpoints
 *   are read from `<issuer>/.well-known/openid-configuration` unless
 *   `discovery` is given, in which case `discovery` is used INSTEAD (give
 *   every endpoint you need). Pass `discovery` when the issuer publishes no
 *   discovery document, or one without an endpoint you need: Amazon Cognito's
 *   omits its revocation endpoint (`https://<your domain>/oauth2/revoke`).
 * - `clientId`: a PUBLIC client (no client secret) registered with the
 *   identity provider. One client can serve iOS, Android and the web.
 * - `redirectUri`: the app's own return address, registered as an allowed
 *   callback on that client. `AuthSession.makeRedirectUri()` builds one.
 * - `scopes`: replaces the default `openid email profile`, so keep those
 *   three when you add one: some identity providers issue a refresh token only
 *   for `offline_access`. `openid` is required (no ID token, no user), and
 *   `getCurrentUser()` needs the `email` claim.
 * - `extraParams`: extra authorization-request parameters, for example an
 *   `audience` for an identity provider that needs one to issue a JWT access
 *   token, or `prompt: 'login'` to make the provider ask for credentials even
 *   when its browser session is still signed in.
 * - `subjectToken`: which of the provider's tokens to exchange. It must be a
 *   JWT whose `iss` and `aud` match the issuer registration on your Vectros
 *   app context. An ID token's `aud` is always the client id; an access
 *   token's `aud` is the API it was issued for. For example, Amazon Cognito:
 *   `'id_token'`; Auth0 with an API audience: `'access_token'`. With
 *   `'id_token'`, the identity provider must return an ID token on every
 *   refresh too.
 * - `exchangeEndpoint`: the full URL of `POST /v1/auth/token/exchange`.
 * - `storageKey`: the secure-store key prefix for the refresh token (letters,
 *   digits, `.`, `-` and `_`). Defaults to `vectros.auth`.
 * - `keychainAccessible`: passed to `expo-secure-store` on iOS. Its default
 *   allows reads only while the device is unlocked; set
 *   `SecureStore.AFTER_FIRST_UNLOCK` if the app refreshes in the background.
 * - `authSession` / `secureStore`: the `expo-auth-session` and
 *   `expo-secure-store` modules.
 */
export interface ExpoAuthProviderConfig {
  readonly issuer: string;
  readonly discovery?: ExpoDiscoveryDocument;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes?: readonly string[];
  readonly extraParams?: Readonly<Record<string, string>>;
  readonly subjectToken: 'id_token' | 'access_token';
  readonly exchangeEndpoint: string;
  readonly storageKey?: string;
  readonly keychainAccessible?: number;
  readonly authSession: ExpoAuthSessionModule;
  readonly secureStore: ExpoSecureStoreModule;
}

const DEFAULT_SCOPES = ['openid', 'email', 'profile'];
const DEFAULT_STORAGE_KEY = 'vectros.auth';
const STORAGE_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Secure-store values are written in chunks of at most this many characters.
 * On iOS a single keychain value above about 2048 bytes can be refused, and
 * some identity providers issue refresh tokens close to that size.
 */
export const SECURE_STORE_CHUNK_CHARS = 2000;

/** The most chunks one stored value may use; deleting always clears this many, so an interrupted write leaves nothing behind. */
const MAX_CHUNKS = 16;

/** Refresh the identity provider's tokens when they are this close to expiry. */
const REFRESH_BEFORE_MS = 60_000;

/** The lifetime assumed for tokens that state none. */
const UNKNOWN_LIFETIME_MS = 5 * 60_000;

const CANCELLED = 'Sign-in was cancelled.';
const NO_ID_TOKEN =
  'The identity provider returned no ID token. Request the openid scope; with subjectToken "id_token" the provider must also return an ID token when refreshing.';

// ---- Helpers ---------------------------------------------------------------

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Decodes a base64url string as UTF-8 without `atob` or `TextDecoder`, which
 * older React Native runtimes lack. Returns null on a character outside the
 * alphabet.
 */
function decodeBase64UrlUtf8(input: string): string | null {
  const clean = input.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  let escaped = '';
  for (const ch of clean) {
    const index = BASE64URL.indexOf(ch);
    if (index < 0) return null;
    value = ((value << 6) | index) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      escaped += `%${((value >> bits) & 0xff).toString(16).padStart(2, '0')}`;
    }
  }
  try {
    return decodeURIComponent(escaped);
  } catch {
    return null;
  }
}

/** The claims of a JWT, unverified, or null when `token` is not a JWT. Display and expiry only, never trust. */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const payload = token.split('.')[1];
  if (payload === undefined) return null;
  const json = decodeBase64UrlUtf8(payload);
  if (json === null) return null;
  try {
    const claims: unknown = JSON.parse(json);
    return claims !== null && typeof claims === 'object' && !Array.isArray(claims)
      ? (claims as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * When a JWT received at `receivedAtMs` stops being usable, by the device's
 * clock: its own lifetime (`exp - iat`) counted from receipt, so a device
 * clock that is wrong does not shorten or lengthen it. Null when the token
 * carries no `exp` and `iat`.
 */
function jwtDeadline(token: string, receivedAtMs: number): number | null {
  const claims = decodeJwtClaims(token);
  const exp = claims?.['exp'];
  const iat = claims?.['iat'];
  return typeof exp === 'number' && typeof iat === 'number' ? receivedAtMs + (exp - iat) * 1000 : null;
}

/** True when `e` is the identity provider refusing the refresh token itself (RFC 6749 §5.2 `invalid_grant`). */
function isInvalidGrant(e: unknown): boolean {
  if (e === null || typeof e !== 'object') return false;
  const { code, error } = e as { code?: unknown; error?: unknown };
  return code === 'invalid_grant' || error === 'invalid_grant';
}

function mapExpoError(e: unknown, fallback: string): AuthError {
  if (e instanceof AuthError) return e;
  if (e instanceof Error) {
    if (e.name === 'TypeError' && /fetch|network/i.test(e.message)) {
      return new AuthError('NETWORK_ERROR', e.message);
    }
    return new AuthError('UNKNOWN', e.message);
  }
  return new AuthError('UNKNOWN', fallback);
}

function storageError(e: unknown): AuthError {
  if (e instanceof AuthError) return e;
  return new AuthError('UNKNOWN', `Secure storage failed: ${e instanceof Error ? e.message : String(e)}`);
}

/** The session held in memory: the identity provider's current tokens and when they stop being usable (device clock). */
interface Session {
  readonly idToken: string | null;
  readonly idTokenDeadlineMs: number | null;
  readonly accessToken: string;
  readonly expiresAtMs: number;
}

// ---- The provider ----------------------------------------------------------

/**
 * Concrete AuthProviderAdapter + HostedRedirectAuth for an Expo app signing in
 * through an OpenID Connect identity provider with a public client and PKCE.
 */
export class ExpoAuthProvider implements AuthProviderAdapter, HostedRedirectAuth {
  private readonly scopes: string[];
  private readonly storageKey: string;
  private readonly storeOptions: ExpoSecureStoreOptions | undefined;
  private discoveryPromise: Promise<ExpoDiscoveryDocument> | null = null;
  private session: Session | null = null;
  private refreshing: Promise<Session | null> | null = null;
  /**
   * Bumped by sign-in and sign-out. A refresh or sign-in that started under an
   * older generation does not install its result, so neither can restore a
   * session the user has just ended.
   */
  private generation = 0;
  /**
   * Every secure-store operation runs through this queue, one at a time and in
   * call order. A sign-out therefore runs after any write already queued, and
   * reads, deletes and revokes the token that write stored.
   */
  private storeQueue: Promise<unknown> = Promise.resolve();
  /**
   * Set when a sign-out could not delete the stored refresh token (a locked
   * keychain, for example). Until a later delete succeeds, nothing restores a
   * session from it, and every refresh retries the delete first.
   */
  private pendingDelete = false;

  constructor(private readonly config: ExpoAuthProviderConfig) {
    this.scopes = [...(config.scopes ?? DEFAULT_SCOPES)];
    this.storageKey = config.storageKey ?? DEFAULT_STORAGE_KEY;
    this.storeOptions =
      config.keychainAccessible === undefined ? undefined : { keychainAccessible: config.keychainAccessible };
    if (!STORAGE_KEY_PATTERN.test(this.storageKey)) {
      throw new Error('ExpoAuthProvider: storageKey may contain only letters, digits, ".", "-" and "_".');
    }
    assertExchangeEndpoint(config.exchangeEndpoint);
  }

  // ---- AuthProviderAdapter ----

  /**
   * The signed-in user from the ID token, or null. Null also when the session
   * cannot be refreshed right now (an app launched offline): the stored
   * refresh token is kept, and the next call after the device reconnects
   * restores the session. `<AuthProvider>` reads this once at mount; call
   * `handleRedirectCallback()` from `useAuth()` to make it read again.
   */
  async getCurrentUser(): Promise<AuthUser | null> {
    try {
      const session = await this.currentSession();
      const claims = session?.idToken ? decodeJwtClaims(session.idToken) : null;
      const sub = claims?.['sub'];
      const email = claims?.['email'];
      if (typeof sub !== 'string' || typeof email !== 'string') return null;
      const givenName = claims?.['given_name'];
      const familyName = claims?.['family_name'];
      return {
        sub,
        email,
        firstName: typeof givenName === 'string' ? givenName : null,
        lastName: typeof familyName === 'string' ? familyName : null,
      };
    } catch {
      return null;
    }
  }

  async getIdToken(): Promise<string | null> {
    try {
      return (await this.currentSession())?.idToken ?? null;
    } catch {
      return null;
    }
  }

  /**
   * The identity provider's current access token, refreshed when needed, or
   * null with no session. For calls to the identity provider itself, for
   * example Amazon Cognito's `DeleteUser` (which needs the
   * `aws.cognito.signin.user.admin` scope).
   */
  async getAccessToken(): Promise<string | null> {
    try {
      return (await this.currentSession())?.accessToken ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Ends the session on this device: forgets the in-memory tokens and every
   * cached Vectros bearer, and deletes the stored refresh token. Then, without
   * waiting, asks the identity provider to revoke that token when it offers a
   * revocation endpoint; a slow or failed revocation never delays or undoes
   * the local sign-out.
   *
   * If the secure store refuses the delete (a locked keychain, for example),
   * this throws `AuthError` ("Secure storage failed: …") so the app can tell
   * the user and retry, and `<AuthProvider>` keeps showing them signed in. The
   * in-memory session is gone either way, nothing restores one from the stored
   * token in this process, and the next sign-in, refresh or sign-out retries
   * the delete.
   *
   * The provider's own browser session is not ended: pass
   * `extraParams: { prompt: 'login' }` to make the next sign-in ask for
   * credentials. A Vectros bearer already handed out stays valid until it
   * expires.
   */
  async signOut(): Promise<void> {
    this.generation += 1;
    this.session = null;
    this.refreshing = null;
    clearVectrosApiTokenCache();
    let refreshToken: string | null;
    try {
      refreshToken = await this.store(() => this.readAndDelete());
    } catch (e) {
      this.pendingDelete = true;
      throw storageError(e);
    }
    this.pendingDelete = false;
    if (refreshToken !== null) void this.revoke(refreshToken);
  }

  // ---- HostedRedirectAuth ----

  /**
   * Opens the identity provider's sign-in page in the system browser and,
   * when the user completes it, establishes and stores the session. Any
   * Vectros bearer cached for a previous user is forgotten. Throws `AuthError`
   * when the user cancels ("Sign-in was cancelled."), when another sign-in is
   * already open, when the identity provider returns an error or no ID token,
   * when the code exchange fails, when a sign-out happened meanwhile, or when
   * the session cannot be saved to secure storage.
   *
   * Unlike the browser providers, the result comes back to this call rather
   * than through a page load, so `handleRedirectCallback` has nothing left to
   * complete. Call it afterwards anyway (`await signInWithRedirect(); await
   * handleRedirectCallback();`) so `<AuthProvider>` reloads the signed-in
   * user. `options.returnTo` is ignored: the app is still on the screen it
   * started from.
   */
  async signInWithRedirect(_options?: { readonly returnTo?: string }): Promise<void> {
    const { authSession, clientId, redirectUri } = this.config;
    const startGeneration = this.generation;
    const discovery = await this.discovery();
    const request = new authSession.AuthRequest({
      clientId,
      redirectUri,
      scopes: this.scopes,
      usePKCE: true,
      ...(this.config.extraParams ? { extraParams: { ...this.config.extraParams } } : {}),
    });

    let result: ExpoAuthSessionResult;
    try {
      result = await request.promptAsync(discovery);
    } catch (e) {
      throw mapExpoError(e, 'Could not open the sign-in page.');
    }
    if (result.type === 'error') {
      const description = result.params['error_description'] ?? result.error?.message ?? result.params['error'];
      throw new AuthError('UNKNOWN', description ?? 'Sign-in failed.');
    }
    if (result.type === 'locked') {
      throw new AuthError('UNKNOWN', 'Another sign-in is already in progress.');
    }
    if (result.type !== 'success') {
      throw new AuthError('UNKNOWN', CANCELLED);
    }
    const code = result.params['code'];
    if (!code || !request.codeVerifier) {
      throw new AuthError('UNKNOWN', 'Sign-in returned no authorization code.');
    }

    let tokens: ExpoTokenResponse;
    try {
      tokens = await authSession.exchangeCodeAsync(
        { clientId, code, redirectUri, extraParams: { code_verifier: request.codeVerifier } },
        discovery,
      );
    } catch (e) {
      throw mapExpoError(e, 'Sign-in could not be completed.');
    }

    if (this.generation !== startGeneration) {
      // The user signed out while this sign-in was in flight: do not install it.
      if (tokens.refreshToken) void this.revoke(tokens.refreshToken);
      throw new AuthError('UNKNOWN', CANCELLED);
    }
    if (!tokens.idToken) {
      throw new AuthError('UNKNOWN', NO_ID_TOKEN);
    }

    this.generation += 1;
    this.refreshing = null;
    clearVectrosApiTokenCache();
    this.session = this.toSession(tokens, null);
    const refreshToken = tokens.refreshToken;
    try {
      // Without a refresh token the session lasts only as long as this one;
      // remove any older stored token so it cannot resurrect another identity.
      await this.store(() => (refreshToken ? this.writeChunks(refreshToken) : this.deleteChunks()));
    } catch (e) {
      this.session = null;
      // The tokens just issued are not stored, so nothing will use them again.
      if (refreshToken) void this.revoke(refreshToken);
      throw storageError(e);
    }
    this.pendingDelete = false;
  }

  /**
   * Nothing to complete on React Native (see {@link signInWithRedirect});
   * resolves at once. `<AuthProvider>` reloads the user after it, so it also
   * serves to re-read the session, for example when the device reconnects.
   */
  async handleRedirectCallback(): Promise<void> {
    // The authorization result was handled inside signInWithRedirect.
  }

  /** {@link HostedRedirectAuth.acceptInvite}: binds a pending invitation, discarding the minted bearer. */
  async acceptInvite(inviteToken: string): Promise<void> {
    await this.exchangeToken({ inviteToken });
  }

  // ---- The Vectros bridge ----

  /**
   * Exchanges the identity provider's current token (`config.subjectToken`)
   * for a Vectros bearer. Refreshes the provider's tokens first when they are
   * within a minute of expiry. Throws `AuthError('INVALID_CREDENTIALS')` with
   * no session, and the exchange's own errors otherwise (see
   * `exchangeSubjectToken`). An issuer registration still pending
   * verification answers 404, the same as an unknown issuer.
   */
  async exchangeToken(options?: TokenExchangeOptions): Promise<ExchangedToken> {
    const session = await this.currentSession();
    const subject = this.config.subjectToken === 'id_token' ? session?.idToken : session?.accessToken;
    if (!subject) {
      throw new AuthError('INVALID_CREDENTIALS', 'Not signed in: there is no token to exchange.');
    }
    return exchangeSubjectToken(this.config.exchangeEndpoint, subject, options);
  }

  /**
   * `PartnerApiTokenMinter`-shaped wrapper for the shared token cache, wired
   * with `setPartnerApiTokenMinter`. `tenantId` is ignored: the issuer
   * registration decides the tenant. `contextId` is forwarded for an issuer
   * registered on more than one app context. The cache retries the
   * concurrent-first-exchange race itself, so this call does not.
   */
  async mintPartnerApiToken(_tenantId?: unknown, contextId?: string): Promise<ExchangedToken> {
    return this.exchangeToken({ ...(contextId ? { contextId } : {}), skipOwnRetry: true });
  }

  // ---- Session ----

  /**
   * The current session, refreshed from the stored refresh token when the
   * in-memory one is missing or about to expire. Concurrent callers share one
   * refresh. Returns null when there is no stored refresh token or the
   * identity provider refused it (`invalid_grant`, which also deletes it).
   * Throws when the refresh could not reach the identity provider, keeping
   * the stored token: an app launched offline is not signed out.
   */
  private async currentSession(): Promise<Session | null> {
    if (this.session && this.session.expiresAtMs - REFRESH_BEFORE_MS > Date.now()) {
      return this.session;
    }
    if (!this.refreshing) {
      const pending: Promise<Session | null> = this.refresh().finally(() => {
        if (this.refreshing === pending) this.refreshing = null;
      });
      this.refreshing = pending;
    }
    return this.refreshing;
  }

  private async refresh(): Promise<Session | null> {
    const generation = this.generation;
    if (this.pendingDelete) {
      // A sign-out could not delete the stored token: retry, and never restore from it.
      const stale = await this.store(() => this.readAndDelete()).catch(() => undefined);
      if (stale !== undefined) {
        this.pendingDelete = false;
        if (stale !== null) void this.revoke(stale);
      }
      return null;
    }
    let refreshToken: string | null;
    try {
      refreshToken = await this.store(() => this.readChunks());
    } catch (e) {
      throw storageError(e);
    }
    if (refreshToken === null) {
      if (generation === this.generation) this.session = null;
      return null;
    }
    const discovery = await this.discovery();
    let tokens: ExpoTokenResponse;
    try {
      tokens = await this.config.authSession.refreshAsync({ clientId: this.config.clientId, refreshToken }, discovery);
    } catch (e) {
      if (isInvalidGrant(e)) {
        if (generation === this.generation) {
          this.session = null;
          await this.store(() => this.deleteChunks()).catch(() => undefined);
        }
        return null;
      }
      throw mapExpoError(e, 'Could not refresh the session.');
    }
    if (generation !== this.generation) {
      // Signed out (or in again) meanwhile: this response is not installed. A
      // rotated refresh token in it is live and was never stored, so revoke it.
      if (tokens.refreshToken && tokens.refreshToken !== refreshToken) void this.revoke(tokens.refreshToken);
      return this.session;
    }

    // A refresh response may omit the ID token (OpenID Connect allows it).
    // Keep the previous one only while it is still usable.
    const previous = this.session;
    const keepPrevious =
      !tokens.idToken &&
      previous?.idToken != null &&
      previous.idTokenDeadlineMs != null &&
      previous.idTokenDeadlineMs - REFRESH_BEFORE_MS > Date.now();
    if (!tokens.idToken && !keepPrevious && this.config.subjectToken === 'id_token') {
      // No usable ID token to exchange. Refreshing again would fail the same
      // way on every call (rotating the refresh token each time), so end the
      // session here and say why.
      this.generation += 1;
      this.session = null;
      await this.store(() => this.deleteChunks()).catch(() => undefined);
      void this.revoke(tokens.refreshToken ?? refreshToken);
      throw new AuthError('UNKNOWN', NO_ID_TOKEN);
    }
    const session = this.toSession(tokens, keepPrevious ? previous : null);
    this.session = session;
    // A provider that rotates refresh tokens returns a new one with every
    // refresh; one that does not, omits it and the stored token stays valid.
    const rotated = tokens.refreshToken;
    if (rotated && rotated !== refreshToken) {
      // A failed write keeps the in-memory session; the device then holds the
      // superseded token, and the next launch may have to sign in again.
      await this.store(() => this.writeChunks(rotated)).catch(() => undefined);
    }
    return session;
  }

  /**
   * Builds the in-memory session. Its expiry is the earliest deadline among
   * the access token (the response's stated lifetime, else the token's own)
   * and, when the ID token is the one exchanged, the ID token. Deadlines are
   * counted from receipt on the device's clock.
   */
  private toSession(tokens: ExpoTokenResponse, previous: Session | null): Session {
    const now = Date.now();
    const idToken = tokens.idToken ?? previous?.idToken ?? null;
    const idTokenDeadlineMs = tokens.idToken ? jwtDeadline(tokens.idToken, now) : (previous?.idTokenDeadlineMs ?? null);
    const accessDeadlineMs =
      typeof tokens.expiresIn === 'number' ? now + tokens.expiresIn * 1000 : jwtDeadline(tokens.accessToken, now);
    const deadlines = [accessDeadlineMs];
    if (this.config.subjectToken === 'id_token') deadlines.push(idTokenDeadlineMs);
    const known = deadlines.filter((d): d is number => d !== null);
    const expiresAtMs = known.length > 0 ? Math.min(...known) : now + UNKNOWN_LIFETIME_MS;
    return { idToken, idTokenDeadlineMs, accessToken: tokens.accessToken, expiresAtMs };
  }

  private discovery(): Promise<ExpoDiscoveryDocument> {
    if (this.config.discovery) return Promise.resolve(this.config.discovery);
    this.discoveryPromise ??= this.config.authSession.fetchDiscoveryAsync(this.config.issuer).catch((e: unknown) => {
      this.discoveryPromise = null;
      throw mapExpoError(e, 'Could not read the identity provider configuration.');
    });
    return this.discoveryPromise;
  }

  /** Best-effort revocation of a refresh token; never throws. */
  private async revoke(token: string): Promise<void> {
    try {
      const discovery = await this.discovery();
      if (discovery.revocationEndpoint) {
        await this.config.authSession.revokeAsync({ clientId: this.config.clientId, token }, discovery);
      }
    } catch {
      // Best effort: the device no longer holds the token either way.
    }
  }

  // ---- Secure storage, chunked and serialized ----
  //
  // `<key>.n` holds the chunk count; `<key>.0` … `<key>.<n-1>` hold the value.

  private store<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.storeQueue.then(operation, operation);
    this.storeQueue = run.catch(() => undefined);
    return run;
  }

  private async readChunks(): Promise<string | null> {
    const { secureStore } = this.config;
    const count = Number(await secureStore.getItemAsync(`${this.storageKey}.n`, this.storeOptions));
    if (!Number.isInteger(count) || count <= 0 || count > MAX_CHUNKS) return null;
    const parts: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const part = await secureStore.getItemAsync(`${this.storageKey}.${i}`, this.storeOptions);
      if (part === null) return null;
      parts.push(part);
    }
    return parts.join('');
  }

  private async writeChunks(value: string): Promise<void> {
    const { secureStore } = this.config;
    const count = Math.ceil(value.length / SECURE_STORE_CHUNK_CHARS);
    if (count > MAX_CHUNKS) {
      throw new AuthError('UNKNOWN', 'The refresh token is too long to store.');
    }
    // Clear the count first: an interrupted write then reads as "no session"
    // rather than as a token spliced from two different values.
    await secureStore.deleteItemAsync(`${this.storageKey}.n`, this.storeOptions);
    for (let i = 0; i < count; i += 1) {
      await secureStore.setItemAsync(
        `${this.storageKey}.${i}`,
        value.slice(i * SECURE_STORE_CHUNK_CHARS, (i + 1) * SECURE_STORE_CHUNK_CHARS),
        this.storeOptions,
      );
    }
    for (let i = count; i < MAX_CHUNKS; i += 1) {
      await secureStore.deleteItemAsync(`${this.storageKey}.${i}`, this.storeOptions);
    }
    await secureStore.setItemAsync(`${this.storageKey}.n`, String(count), this.storeOptions);
  }

  /**
   * Deletes the count and every chunk slot, so chunks orphaned by an
   * interrupted write go too. Throws if the secure store refuses a delete.
   */
  private async deleteChunks(): Promise<void> {
    const { secureStore } = this.config;
    await secureStore.deleteItemAsync(`${this.storageKey}.n`, this.storeOptions);
    for (let i = 0; i < MAX_CHUNKS; i += 1) {
      await secureStore.deleteItemAsync(`${this.storageKey}.${i}`, this.storeOptions);
    }
  }

  /**
   * Reads the stored token (null when there is none or it cannot be read),
   * then deletes it. Throws only when the delete fails: a token that could not
   * be read is still deleted, it just cannot be revoked.
   */
  private async readAndDelete(): Promise<string | null> {
    const stored = await this.readChunks().catch(() => null);
    await this.deleteChunks();
    return stored;
  }
}
