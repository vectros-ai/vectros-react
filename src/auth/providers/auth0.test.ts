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
  it('exchanges the current ID token for a partner-API bearer', async () => {
    mockClient.getIdTokenClaims.mockResolvedValue({ __raw: 'the-id-token' });
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
      subject_token: 'the-id-token',
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
    });
  });

  it('forwards inviteToken/signupType on the request body when supplied', async () => {
    mockClient.getIdTokenClaims.mockResolvedValue({ __raw: 'the-id-token' });
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
    mockClient.getIdTokenClaims.mockResolvedValue({ __raw: 'the-id-token' });
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
    mockClient.getIdTokenClaims.mockResolvedValue({ __raw: 'the-id-token' });
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
    mockClient.getIdTokenClaims.mockResolvedValue({ __raw: 'the-id-token' });
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

  it('throws INVALID_CREDENTIALS when there is no ID token to exchange', async () => {
    mockClient.getIdTokenClaims.mockResolvedValue(undefined);
    await expect(provider().exchangeToken()).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('maps a non-ok exchange response to an AuthError carrying the OAuth error code', async () => {
    mockClient.getIdTokenClaims.mockResolvedValue({ __raw: 'the-id-token' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: () =>
          Promise.resolve({ error: 'invalid_grant', error_description: 'The presented token could not be exchanged' }),
      }),
    );

    const err = await provider()
      .exchangeToken()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).message).toContain('403');
    expect((err as AuthError).message).toContain('invalid_grant');
  });

  it('maps a fetch/network failure to NETWORK_ERROR', async () => {
    mockClient.getIdTokenClaims.mockResolvedValue({ __raw: 'the-id-token' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    await expect(provider().exchangeToken()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });
});
