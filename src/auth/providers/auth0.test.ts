// ---------------------------------------------------------------------------
// Auth0AuthProvider tests.
//
// Same idiom as cognito.*.test.ts: mock the underlying SDK (here, the
// @auth0/auth0-spa-js `Auth0Client` class) and drive the provider's public
// surface against it — no real network, no real Auth0 tenant.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Auth0Client class. Each test builds its own instance's method
// mocks via `mockClientMethods`, then `Auth0AuthProvider`'s constructor
// receives THIS shared instance (the mock constructor always returns it).
const mockClient = {
  getIdTokenClaims: vi.fn(),
  getTokenSilently: vi.fn(),
  loginWithRedirect: vi.fn(),
  handleRedirectCallback: vi.fn(),
  logout: vi.fn(),
};

// A regular function, NOT an arrow function — arrow functions aren't
// constructible, and this needs to work when vi.fn() invokes it via `new`.
vi.mock('@auth0/auth0-spa-js', () => ({
  Auth0Client: vi.fn().mockImplementation(function Auth0ClientMock() {
    return mockClient;
  }),
}));

import { Auth0AuthProvider } from './auth0';
import { AuthError } from '../errors';
import {
  __resetVectrosApiTokenCacheForTest,
  getVectrosApiToken,
  setPartnerApiTokenMinter,
} from '../vectrosApiTokenCache';

const CONFIG = {
  domain: 'test-tenant.us.auth0.com',
  clientId: 'test-client-id',
  redirectUri: 'https://app.test/callback',
  exchangeEndpoint: 'https://api.test/v1/auth/token/exchange',
};

function provider(): Auth0AuthProvider {
  return new Auth0AuthProvider(CONFIG);
}

/** Reset window.location to a clean, query-string-free URL between tests. */
function resetLocation(path = '/callback'): void {
  window.history.pushState({}, '', path);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetLocation();
  // Default: refresh succeeds as a no-op (cache hit) so tests that only care
  // about getIdTokenClaims' return value don't also have to stub this.
  mockClient.getTokenSilently.mockResolvedValue('mock-access-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Unconditional, not just the two tests that call vi.useFakeTimers() —
  // if either of THOSE tests' own expect() throws, their inline
  // vi.useRealTimers() call never runs, and fake-timer state would otherwise
  // leak into every later test in this file. A no-op when real timers are
  // already active.
  vi.useRealTimers();
});

describe('Auth0AuthProvider.getCurrentUser', () => {
  // getCurrentUser derives identity from getIdTokenClaims() directly — NOT
  // isAuthenticated()+getUser() — to avoid decoding the cached ID token
  // multiple times per call (isAuthenticated() calls getUser() internally in
  // the real SDK; getUser()/getIdTokenClaims() both re-derive from the same
  // cache entry). See the fix's commit/review note for the measured redundancy.
  it('maps an authenticated Auth0 user onto AuthUser', async () => {
    mockClient.getIdTokenClaims.mockResolvedValue({
      __raw: 'eyJhbGciOi...',
      sub: 'auth0|abc123',
      email: 'alice@example.com',
      given_name: 'Alice',
      family_name: 'Smith',
    });

    await expect(provider().getCurrentUser()).resolves.toEqual({
      sub: 'auth0|abc123',
      email: 'alice@example.com',
      firstName: 'Alice',
      lastName: 'Smith',
    });
  });

  it('defaults missing given_name/family_name to null', async () => {
    mockClient.getIdTokenClaims.mockResolvedValue({
      __raw: 'eyJhbGciOi...',
      sub: 'auth0|abc123',
      email: 'alice@example.com',
    });

    await expect(provider().getCurrentUser()).resolves.toEqual({
      sub: 'auth0|abc123',
      email: 'alice@example.com',
      firstName: null,
      lastName: null,
    });
  });

  it('returns null when there is no session (contract: MUST NOT throw)', async () => {
    mockClient.getIdTokenClaims.mockResolvedValue(undefined);
    await expect(provider().getCurrentUser()).resolves.toBeNull();
  });

  it('returns null (not throw) when getIdTokenClaims itself throws', async () => {
    mockClient.getIdTokenClaims.mockRejectedValue(new Error('boom'));
    await expect(provider().getCurrentUser()).resolves.toBeNull();
  });

  it('returns null when the claims are missing sub/email (malformed/partial token)', async () => {
    mockClient.getIdTokenClaims.mockResolvedValue({ __raw: 'eyJhbGciOi...', sub: 'auth0|abc123' }); // no email
    await expect(provider().getCurrentUser()).resolves.toBeNull();
  });

  it('refreshes via getTokenSilently BEFORE reading claims, so a stale cached token gets picked up', async () => {
    // Regression guard for the bug this fixes: getIdTokenClaims() alone is a
    // pure cache read and never refreshes, so a long-lived tab would read a
    // stale/expired entry forever. getTokenSilently() must run first on every
    // call — a cache hit costs nothing extra, but it's the SDK's only call
    // that actually triggers a refresh when the cached token has expired.
    const callOrder: string[] = [];
    mockClient.getTokenSilently.mockImplementation(async () => {
      callOrder.push('getTokenSilently');
      return 'access-token';
    });
    mockClient.getIdTokenClaims.mockImplementation(async () => {
      callOrder.push('getIdTokenClaims');
      return { __raw: 'eyJhbGciOi...', sub: 'auth0|abc123', email: 'alice@example.com' };
    });

    await provider().getCurrentUser();

    expect(callOrder).toEqual(['getTokenSilently', 'getIdTokenClaims']);
  });

  it('returns null (not throw) when getTokenSilently rejects (no session / no refresh token — login_required)', async () => {
    mockClient.getTokenSilently.mockRejectedValue(new Error('Login required'));
    await expect(provider().getCurrentUser()).resolves.toBeNull();
    // Must not fall through to reading (stale/absent) claims after a failed refresh.
    expect(mockClient.getIdTokenClaims).not.toHaveBeenCalled();
  });
});

describe('Auth0AuthProvider.getIdToken', () => {
  it('returns the raw ID token when a session exists', async () => {
    mockClient.getIdTokenClaims.mockResolvedValue({ __raw: 'eyJhbGciOi...' });
    await expect(provider().getIdToken()).resolves.toBe('eyJhbGciOi...');
  });

  it('returns null when there are no claims (no session)', async () => {
    mockClient.getIdTokenClaims.mockResolvedValue(undefined);
    await expect(provider().getIdToken()).resolves.toBeNull();
  });

  it('returns null (not throw) on failure', async () => {
    mockClient.getIdTokenClaims.mockRejectedValue(new Error('boom'));
    await expect(provider().getIdToken()).resolves.toBeNull();
  });

  it('returns null (not throw) when getTokenSilently rejects (no session / no refresh token)', async () => {
    mockClient.getTokenSilently.mockRejectedValue(new Error('Login required'));
    await expect(provider().getIdToken()).resolves.toBeNull();
  });
});

describe('Auth0AuthProvider.signInWithRedirect', () => {
  it('calls loginWithRedirect with no appState when returnTo is omitted', async () => {
    mockClient.loginWithRedirect.mockResolvedValue(undefined);
    await provider().signInWithRedirect();
    expect(mockClient.loginWithRedirect).toHaveBeenCalledWith({ appState: undefined });
  });

  it('carries returnTo through as appState', async () => {
    mockClient.loginWithRedirect.mockResolvedValue(undefined);
    await provider().signInWithRedirect({ returnTo: '/cases/42' });
    expect(mockClient.loginWithRedirect).toHaveBeenCalledWith({
      appState: { returnTo: '/cases/42' },
    });
  });

  it('maps a loginWithRedirect failure to AuthError', async () => {
    mockClient.loginWithRedirect.mockRejectedValue(new Error('popup/redirect blocked'));
    const err = await provider()
      .signInWithRedirect()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).code).toBe('UNKNOWN');
  });

  it('maps a network-flavored failure to NETWORK_ERROR', async () => {
    mockClient.loginWithRedirect.mockRejectedValue(
      Object.assign(new TypeError('Failed to fetch'), { name: 'TypeError' }),
    );
    const err = await provider()
      .signInWithRedirect()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).code).toBe('NETWORK_ERROR');
  });
});

describe('Auth0AuthProvider.handleRedirectCallback', () => {
  it('processes a real redirect result (code+state present) and strips the query string', async () => {
    resetLocation('/callback?code=abc123&state=xyz');
    mockClient.handleRedirectCallback.mockResolvedValue({ appState: undefined });

    await provider().handleRedirectCallback();

    expect(mockClient.handleRedirectCallback).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe('');
  });

  it('processes an error redirect (error= present), maps the failure to AuthError, and still strips the query string', async () => {
    resetLocation('/callback?error=access_denied&error_description=user+cancelled');
    mockClient.handleRedirectCallback.mockRejectedValue(new Error('access_denied'));

    const err = await provider()
      .handleRedirectCallback()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).message).toBe('access_denied');
    expect(window.location.search).toBe('');
  });

  it('does NOT call the SDK on a plain visit to the callback route (no code/error)', async () => {
    resetLocation('/callback');
    await provider().handleRedirectCallback();
    expect(mockClient.handleRedirectCallback).not.toHaveBeenCalled();
  });

  it('does NOT treat an unrelated query param containing "code=" as a real redirect result', async () => {
    // Regression guard: an earlier version used `search.includes('code=')`,
    // a substring match that also matches ?promo_code=/?zip_code=/etc. Real
    // detection must match the exact `code`/`error` query-param KEYS.
    resetLocation('/callback?promo_code=SAVE20');
    await provider().handleRedirectCallback();
    expect(mockClient.handleRedirectCallback).not.toHaveBeenCalled();
  });

  it('does NOT treat an unrelated query param containing "error" as a real redirect result', async () => {
    resetLocation('/callback?campaign_error=0');
    await provider().handleRedirectCallback();
    expect(mockClient.handleRedirectCallback).not.toHaveBeenCalled();
  });

  it("maps Auth0's default unverified-email rejection to EMAIL_NOT_VERIFIED, not the generic UNKNOWN", async () => {
    // Live-tested 2026-08-26: signing up fresh, then immediately attempting
    // to sign in with email verification required, fails with exactly this
    // shape — Auth0's own default error_description.
    resetLocation('/callback?error=unauthorized&error_description=Please+verify+your+email+before+logging+in.');
    mockClient.handleRedirectCallback.mockRejectedValue(
      new Error('Please verify your email before logging in.'),
    );
    const err = await provider()
      .handleRedirectCallback()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('does NOT misclassify an unrelated error that happens to mention "email" as EMAIL_NOT_VERIFIED', async () => {
    resetLocation('/callback?error=server_error&error_description=failed');
    mockClient.handleRedirectCallback.mockRejectedValue(
      new Error('Could not deliver to the configured email address.'),
    );
    const err = await provider()
      .handleRedirectCallback()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).code).toBe('UNKNOWN');
  });
});

describe('Auth0AuthProvider.signOut', () => {
  it('calls logout with returnTo set to the current origin', async () => {
    mockClient.logout.mockResolvedValue(undefined);
    await provider().signOut();
    expect(mockClient.logout).toHaveBeenCalledWith({
      logoutParams: { returnTo: window.location.origin },
    });
  });

  it('maps a logout failure to AuthError', async () => {
    mockClient.logout.mockRejectedValue(new Error('logout unreachable'));
    const err = await provider()
      .signOut()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).code).toBe('UNKNOWN');
    expect((err as AuthError).message).toBe('logout unreachable');
  });
});

describe('Auth0AuthProvider.exchangeToken / mintPartnerApiToken', () => {
  it('exchanges the current ACCESS token (not the ID token) for a partner-API bearer', async () => {
    // Not getIdTokenClaims — the exchange contract requires the presented
    // token's `aud` claim to equal the registered issuer's audience, which
    // only the access token carries (an ID token's `aud` is always the
    // client id, by OIDC spec, regardless of provider).
    mockClient.getTokenSilently.mockResolvedValue('the-access-token');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: 'st_live_abc', expires_in: 3600 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider().mintPartnerApiToken();

    expect(result.token).toBe('st_live_abc');
    expect(result.expiresAtMs).toBeGreaterThan(Date.now());
    expect(fetchMock).toHaveBeenCalledWith(
      CONFIG.exchangeEndpoint,
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body) as Record<
      string,
      unknown
    >;
    expect(body).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'the-access-token',
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    });
  });

  it('forwards inviteToken/signupType on the request body when supplied', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: 'st_live_abc', expires_in: 3600 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await provider().exchangeToken({ inviteToken: 'inv_x', signupType: 'self_serve' });

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body) as Record<
      string,
      unknown
    >;
    expect(body['invite_token']).toBe('inv_x');
    expect(body['signup_type']).toBe('self_serve');
  });

  it('forwards contextId on the request body when supplied to exchangeToken', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: 'st_live_abc', expires_in: 3600 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await provider().exchangeToken({ contextId: 'ctx_billing' });

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body) as Record<
      string,
      unknown
    >;
    expect(body['context_id']).toBe('ctx_billing');
  });

  it('omits context_id from the request body when exchangeToken is called with none', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: 'st_live_abc', expires_in: 3600 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await provider().exchangeToken();

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body) as Record<
      string,
      unknown
    >;
    expect(body).not.toHaveProperty('context_id');
  });

  it('mintPartnerApiToken forwards its second (contextId) argument to exchangeToken', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: 'st_live_abc', expires_in: 3600 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    // First arg (tenantId) is accepted-and-ignored, matching the shared
    // PartnerApiTokenMinter signature — Auth0 resolves the tenant server-side.
    await provider().mintPartnerApiToken('tnt_whatever', 'ctx_billing');

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body) as Record<
      string,
      unknown
    >;
    expect(body['context_id']).toBe('ctx_billing');
  });

  it('throws INVALID_CREDENTIALS when there is no session to mint an access token from', async () => {
    mockClient.getTokenSilently.mockRejectedValue(new Error('Login required'));
    await expect(provider().exchangeToken()).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('mintPartnerApiToken does NOT retry internally on a 403 — deferred entirely to the cache\'s own shared retry', async () => {
    // Regression guard: mintPartnerApiToken's exchangeToken({contextId}) call used to retry HERE
    // (this file's own retry, below) AND, on a persistent failure, AGAIN one layer up in
    // vectrosApiTokenCache.ts's getVectrosApiToken — up to 4 real POSTs to the exchange endpoint
    // for one ordinary re-mint. mintPartnerApiToken now passes skipOwnRetry, so exactly ONE fetch
    // happens here regardless of outcome; see the integration test below for the end-to-end count.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: 'invalid_grant', error_description: 'x' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const err = await provider()
      .mintPartnerApiToken('tnt_whatever')
      .catch((e: unknown) => e);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(AuthError);
  });

  it('a direct exchangeToken() call (bypassing the cache — e.g. self-signup) still retries on its own — nothing else covers that race for it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: 'invalid_grant', error_description: 'x' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const pending = provider()
      .exchangeToken({ signupType: 'self_serve' })
      .catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    await pending;
    vi.useRealTimers();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries once on a persistent 403 (a genuine rejection, not just the race) and still maps to AuthError', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: () =>
        Promise.resolve({ error: 'invalid_grant', error_description: 'The presented token could not be exchanged' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const pending = provider()
      .exchangeToken()
      .catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await pending;
    vi.useRealTimers();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).message).toContain('403');
    expect((err as AuthError).message).toContain('invalid_grant');
  });

  it('retries once on a 403 and succeeds if the identity has cleared the race by the retry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = vi
      .fn()
      // First attempt: this call lost a self-signup race server-side.
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ error: 'invalid_grant', error_description: 'x' }),
      })
      // Retry: the identity now exists (the winner created it), matches directly.
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ access_token: 'st_live_abc', expires_in: 3600 }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const pending = provider().exchangeToken();
    await vi.runAllTimersAsync();
    const result = await pending;
    vi.useRealTimers();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.token).toBe('st_live_abc');
  });

  it('does NOT retry a 403 when inviteToken is set — the server never runs the self-signup race for an invite attempt', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: () =>
        Promise.resolve({ error: 'invalid_grant', error_description: 'The presented token could not be exchanged' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const err = await provider()
      .exchangeToken({ inviteToken: 'inv_expired' })
      .catch((e: unknown) => e);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(AuthError);
  });

  it('does NOT retry a non-403 rejection (e.g. a malformed subject_token, 400)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () =>
        Promise.resolve({ error: 'invalid_request', error_description: 'subject_token is not a well-formed JWT' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const err = await provider()
      .exchangeToken()
      .catch((e: unknown) => e);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).message).toContain('400');
  });

  it('maps a fetch/network failure to NETWORK_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    await expect(provider().exchangeToken()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('parses a real resolvedScope field off the exchange response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: 'st_live_abc',
            expires_in: 3600,
            resolvedScope: { allowedActions: ['records:r:case'], identity: { userId: 'usr_1' } },
          }),
      }),
    );

    const result = await provider().exchangeToken();
    expect(result.resolvedScope).toEqual({ allowedActions: ['records:r:case'], identity: { userId: 'usr_1' } });
  });

  it('degrades to an empty resolvedScope (not throw) when the response omits the field entirely', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ access_token: 'st_live_abc', expires_in: 3600 }),
      }),
    );

    const result = await provider().exchangeToken();
    expect(result.resolvedScope).toEqual({ allowedActions: [], identity: {} });
  });
});

describe('Auth0AuthProvider.acceptInvite', () => {
  it('exchanges with the invite token on the request body and resolves void', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: 'st_live_abc', expires_in: 3600 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider().acceptInvite('inv_x');

    expect(result).toBeUndefined();
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body) as Record<
      string,
      unknown
    >;
    expect(body['invite_token']).toBe('inv_x');
  });

  it('propagates a rejection from the underlying exchange (bad/expired/already-used token)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ error: 'invalid_grant', error_description: 'invite token expired' }),
      }),
    );

    await expect(provider().acceptInvite('inv_expired')).rejects.toBeInstanceOf(AuthError);
  });
});

describe('Auth0AuthProvider wired into vectrosApiTokenCache — end-to-end double-retry regression', () => {
  // The real bug: mintPartnerApiToken() is the ONLY caller vectrosApiTokenCache.ts's
  // getVectrosApiToken ever mints through (main.tsx wires it via
  // setPartnerApiTokenMinter). A persistent 403 on a fresh sign-in used to retry inside
  // exchangeToken() (this file, 2 fetches) AND, once that still failed, again inside the
  // cache's own SHARED_MINT_RETRY_DELAY_MS retry (2 more fetches) — up to 4 real
  // `POST /v1/auth/token/exchange` calls in quick succession for ONE mint. This test wires
  // the two REAL modules together (no mock minter) to pin the fixed, non-stacking count.
  afterEach(() => {
    __resetVectrosApiTokenCacheForTest();
    vi.useRealTimers();
  });

  it('a persistent 403 produces exactly 2 real exchange POSTs total (1 + the cache\'s 1 shared retry), not 4', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: 'invalid_grant', error_description: 'x' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const auth0 = provider();
    setPartnerApiTokenMinter((tenantId, contextId) => auth0.mintPartnerApiToken(tenantId, contextId));

    const pending = getVectrosApiToken('exchange-resolved').catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(err).toBeInstanceOf(Error);
  });

  it('several near-simultaneous consumers (e.g. one useScopeGate per nav item) on a fresh sign-in share ONE mint end to end, real fetch count included', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: 'st_live_shared', expires_in: 3600 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const auth0 = provider();
    setPartnerApiTokenMinter((tenantId, contextId) => auth0.mintPartnerApiToken(tenantId, contextId));

    // Several independent consumers calling in the same synchronous pass, exactly how
    // several mounted useScopeGate instances (one per gated nav item) behave on mount.
    const [t1, t2, t3] = await Promise.all([
      getVectrosApiToken('exchange-resolved'),
      getVectrosApiToken('exchange-resolved'),
      getVectrosApiToken('exchange-resolved'),
    ]);

    expect([t1, t2, t3]).toEqual(['st_live_shared', 'st_live_shared', 'st_live_shared']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
