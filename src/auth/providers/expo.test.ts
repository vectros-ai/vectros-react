import { act, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../AuthProvider';
import { useAuth } from '../useAuth';

import { AuthError } from '../errors';
import { __resetVectrosApiTokenCacheForTest, getVectrosApiToken, setPartnerApiTokenMinter } from '../vectrosApiTokenCache';
import { ExpoAuthProvider, SECURE_STORE_CHUNK_CHARS, decodeJwtClaims } from './expo';
import type {
  ExpoAuthSessionModule,
  ExpoAuthSessionResult,
  ExpoAuthProviderConfig,
  ExpoDiscoveryDocument,
  ExpoTokenResponse,
} from './expo';

const TOKEN_ENDPOINT = 'https://idp.example.com/token';
const DISCOVERY: ExpoDiscoveryDocument = {
  authorizationEndpoint: 'https://idp.example.com/authorize',
  tokenEndpoint: TOKEN_ENDPOINT,
  revocationEndpoint: 'https://idp.example.com/revoke',
};
const EXCHANGE = 'https://api.example.com/v1/auth/token/exchange';

function b64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/** An unsigned JWT with the given claims: the provider only decodes, never verifies. */
function jwt(claims: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'none' }))}.${b64url(JSON.stringify(claims))}.sig`;
}

const nowSec = () => Math.floor(Date.now() / 1000);

function idToken(overrides: Record<string, unknown> = {}): string {
  return jwt({
    sub: 'user-1',
    email: 'ada@example.com',
    given_name: 'Ada',
    family_name: 'Lovelace',
    iat: nowSec(),
    exp: nowSec() + 3600,
    ...overrides,
  });
}

function tokenResponse(overrides: Partial<ExpoTokenResponse> = {}): ExpoTokenResponse {
  return {
    accessToken: jwt({ aud: 'https://api.example.com', iat: nowSec(), exp: nowSec() + 3600 }),
    idToken: idToken(),
    refreshToken: 'refresh-1',
    expiresIn: 3600,
    issuedAt: nowSec(),
    ...overrides,
  };
}

/** A refresh response from a provider that does not rotate refresh tokens. */
function refreshResponse(): ExpoTokenResponse {
  const { refreshToken: _omitted, ...rest } = tokenResponse();
  return rest;
}

class MemoryStore {
  readonly items = new Map<string, string>();
  getItemAsync = vi.fn(async (key: string) => this.items.get(key) ?? null);
  setItemAsync = vi.fn(async (key: string, value: string) => {
    this.items.set(key, value);
  });
  deleteItemAsync = vi.fn(async (key: string) => {
    this.items.delete(key);
  });
}

interface Harness {
  readonly provider: ExpoAuthProvider;
  readonly store: MemoryStore;
  readonly session: {
    promptResult: ExpoAuthSessionResult;
    promptError: Error | null;
    readonly requests: Array<Record<string, unknown>>;
    readonly fetchDiscoveryAsync: ReturnType<typeof vi.fn>;
    readonly exchangeCodeAsync: ReturnType<typeof vi.fn>;
    readonly refreshAsync: ReturnType<typeof vi.fn>;
    readonly revokeAsync: ReturnType<typeof vi.fn>;
  };
}

function harness(overrides: Partial<ExpoAuthProviderConfig> = {}): Harness {
  const store = new MemoryStore();
  const state = {
    promptResult: { type: 'success', params: { code: 'auth-code' } } as ExpoAuthSessionResult,
    promptError: null as Error | null,
    requests: [] as Array<Record<string, unknown>>,
    fetchDiscoveryAsync: vi.fn(async () => DISCOVERY),
    exchangeCodeAsync: vi.fn(async () => tokenResponse()),
    refreshAsync: vi.fn(async () => refreshResponse()),
    revokeAsync: vi.fn(async () => true),
  };
  class FakeAuthRequest {
    codeVerifier?: string;
    constructor(config: Record<string, unknown>) {
      state.requests.push(config);
    }
    async promptAsync(): Promise<ExpoAuthSessionResult> {
      if (state.promptError) throw state.promptError;
      this.codeVerifier = 'verifier-1';
      return state.promptResult;
    }
  }
  const authSession: ExpoAuthSessionModule = {
    AuthRequest: FakeAuthRequest,
    fetchDiscoveryAsync: state.fetchDiscoveryAsync,
    exchangeCodeAsync: state.exchangeCodeAsync,
    refreshAsync: state.refreshAsync,
    revokeAsync: state.revokeAsync,
  };
  const provider = new ExpoAuthProvider({
    issuer: 'https://idp.example.com',
    clientId: 'client-1',
    redirectUri: 'myapp://callback',
    subjectToken: 'id_token',
    exchangeEndpoint: EXCHANGE,
    authSession,
    secureStore: store,
    ...overrides,
  });
  return { provider, store, session: state };
}

function okExchange() {
  return new Response(
    JSON.stringify({ access_token: 'st_minted', expires_in: 900, resolvedScope: { allowedActions: ['records:r'] } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('ExpoAuthProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => okExchange());
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe('signInWithRedirect', () => {
    it('runs a PKCE code request, exchanges the code with its verifier, and stores only the refresh token', async () => {
      const { provider, store, session } = harness({ extraParams: { audience: 'https://api.example.com' } });
      await provider.signInWithRedirect();

      expect(session.requests[0]).toEqual({
        clientId: 'client-1',
        redirectUri: 'myapp://callback',
        scopes: ['openid', 'email', 'profile'],
        usePKCE: true,
        extraParams: { audience: 'https://api.example.com' },
      });
      expect(session.exchangeCodeAsync).toHaveBeenCalledWith(
        { clientId: 'client-1', code: 'auth-code', redirectUri: 'myapp://callback', extraParams: { code_verifier: 'verifier-1' } },
        DISCOVERY,
      );
      expect([...store.items.entries()].sort()).toEqual([
        ['vectros.auth.0', 'refresh-1'],
        ['vectros.auth.n', '1'],
      ]);
      expect(await provider.getCurrentUser()).toEqual({
        sub: 'user-1',
        email: 'ada@example.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
      });
    });

    it('uses a given discovery document instead of fetching one', async () => {
      const { provider, session } = harness({ discovery: DISCOVERY });
      await provider.signInWithRedirect();
      expect(session.fetchDiscoveryAsync).not.toHaveBeenCalled();
    });

    it('throws a cancellation AuthError when the user closes the browser', async () => {
      const { provider, session, store } = harness();
      session.promptResult = { type: 'dismiss' };
      await expect(provider.signInWithRedirect()).rejects.toMatchObject({
        code: 'UNKNOWN',
        message: 'Sign-in was cancelled.',
      });
      expect(store.items.size).toBe(0);
    });

    it("surfaces the identity provider's error description", async () => {
      const { provider, session } = harness();
      session.promptResult = {
        type: 'error',
        params: { error: 'access_denied', error_description: 'User denied' },
        error: { message: 'The resource owner or authorization server denied the request.\nMore info: User denied' },
      };
      await expect(provider.signInWithRedirect()).rejects.toMatchObject({ message: 'User denied' });

      session.promptResult = { type: 'error', params: {}, error: { message: 'state_mismatch' } };
      await expect(provider.signInWithRedirect()).rejects.toMatchObject({ message: 'state_mismatch' });
    });

    it('maps a network failure in the code exchange to NETWORK_ERROR', async () => {
      const { provider, session } = harness();
      session.exchangeCodeAsync.mockRejectedValueOnce(new TypeError('Network request failed'));
      await expect(provider.signInWithRedirect()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    });

    it('splits a refresh token longer than one secure-store value into chunks and reads it back whole', async () => {
      const long = 'r'.repeat(SECURE_STORE_CHUNK_CHARS * 2 + 5);
      const first = harness();
      first.session.exchangeCodeAsync.mockResolvedValueOnce(tokenResponse({ refreshToken: long }));
      await first.provider.signInWithRedirect();
      expect(first.store.items.get('vectros.auth.n')).toBe('3');
      for (const [key, value] of first.store.items) {
        if (key !== 'vectros.auth.n') expect(value.length).toBeLessThanOrEqual(SECURE_STORE_CHUNK_CHARS);
      expect(first.store.items.size).toBe(4);
      }

      // A relaunch: a new provider over the same store refreshes with the reassembled token.
      const relaunched = harness();
      for (const [k, v] of first.store.items) relaunched.store.items.set(k, v);
      await relaunched.provider.getIdToken();
      expect(relaunched.session.refreshAsync).toHaveBeenCalledWith({ clientId: 'client-1', refreshToken: long }, DISCOVERY);
    });

    it('a shorter token replaces a longer one without leaving its old chunks behind', async () => {
      const { provider, store, session } = harness();
      session.exchangeCodeAsync.mockResolvedValueOnce(tokenResponse({ refreshToken: 'x'.repeat(SECURE_STORE_CHUNK_CHARS + 1) }));
      await provider.signInWithRedirect();
      expect(store.items.get('vectros.auth.n')).toBe('2');
      await provider.signInWithRedirect();
      expect([...store.items.keys()].sort()).toEqual(['vectros.auth.0', 'vectros.auth.n']);
    });

    it('rejects a storage key the secure store cannot hold', () => {
      expect(() => harness({ storageKey: 'bad key!' })).toThrow(/storageKey/);
    });
  });

  describe('session restore and refresh', () => {
    it('restores a session on relaunch from the stored refresh token', async () => {
      const { provider, store, session } = harness();
      store.items.set('vectros.auth.n', '1');
      store.items.set('vectros.auth.0', 'refresh-1');
      expect((await provider.getCurrentUser())?.sub).toBe('user-1');
      expect(session.refreshAsync).toHaveBeenCalledTimes(1);
    });

    it('returns null without a stored refresh token, and never calls the identity provider', async () => {
      const { provider, session } = harness();
      expect(await provider.getCurrentUser()).toBeNull();
      expect(session.refreshAsync).not.toHaveBeenCalled();
    });

    it('shares one refresh between concurrent callers', async () => {
      const { provider, store, session } = harness();
      store.items.set('vectros.auth.n', '1');
      store.items.set('vectros.auth.0', 'refresh-1');
      await Promise.all([provider.getIdToken(), provider.getCurrentUser(), provider.getIdToken()]);
      expect(session.refreshAsync).toHaveBeenCalledTimes(1);
    });

    it('refreshes when the ID token is within a minute of its exp, even if the response lifetime is longer', async () => {
      const { provider, session } = harness();
      session.exchangeCodeAsync.mockResolvedValueOnce(
        tokenResponse({ idToken: idToken({ exp: nowSec() + 30 }), expiresIn: 3600 }),
      );
      await provider.signInWithRedirect();
      await provider.getIdToken();
      expect(session.refreshAsync).toHaveBeenCalledTimes(1);
    });

    it('stores a rotated refresh token', async () => {
      const { provider, store, session } = harness();
      store.items.set('vectros.auth.n', '1');
      store.items.set('vectros.auth.0', 'refresh-1');
      session.refreshAsync.mockResolvedValueOnce(tokenResponse({ refreshToken: 'refresh-2' }));
      await provider.getIdToken();
      expect(store.items.get('vectros.auth.0')).toBe('refresh-2');
    });

    it('deletes the stored token and signs out when the identity provider refuses it (invalid_grant)', async () => {
      const { provider, store, session } = harness();
      store.items.set('vectros.auth.n', '1');
      store.items.set('vectros.auth.0', 'refresh-1');
      session.refreshAsync.mockRejectedValueOnce(Object.assign(new Error('revoked'), { code: 'invalid_grant' }));
      expect(await provider.getCurrentUser()).toBeNull();
      expect(store.items.size).toBe(0);
    });

    it('keeps the stored token when the refresh cannot reach the identity provider (an offline launch)', async () => {
      const { provider, store, session } = harness();
      store.items.set('vectros.auth.n', '1');
      store.items.set('vectros.auth.0', 'refresh-1');
      session.refreshAsync.mockRejectedValueOnce(new TypeError('Network request failed'));
      expect(await provider.getCurrentUser()).toBeNull();
      expect(store.items.get('vectros.auth.0')).toBe('refresh-1');
      // Back online: the next call refreshes and the session returns.
      expect((await provider.getCurrentUser())?.sub).toBe('user-1');
    });

    it('a refresh still in flight when the user signs out does not restore the session', async () => {
      const { provider, store, session } = harness();
      store.items.set('vectros.auth.n', '1');
      store.items.set('vectros.auth.0', 'refresh-1');
      let release!: (value: ExpoTokenResponse) => void;
      session.refreshAsync.mockImplementationOnce(() => new Promise<ExpoTokenResponse>((r) => (release = r)));
      const pending = provider.getIdToken();
      await vi.waitFor(() => expect(session.refreshAsync).toHaveBeenCalled());
      await provider.signOut();
      release(tokenResponse({ refreshToken: 'refresh-2' }));
      await pending;
      expect(store.items.size).toBe(0);
      expect(await provider.getCurrentUser()).toBeNull();
    });
  });

  describe('signOut', () => {
    it('forgets the session, deletes the stored token and revokes it', async () => {
      const { provider, store, session } = harness();
      await provider.signInWithRedirect();
      await provider.signOut();
      expect(store.items.size).toBe(0);
      expect(session.revokeAsync).toHaveBeenCalledWith({ clientId: 'client-1', token: 'refresh-1' }, DISCOVERY);
      expect(await provider.getCurrentUser()).toBeNull();
    });

    it('still signs out locally when revocation fails or is not offered', async () => {
      const failing = harness();
      await failing.provider.signInWithRedirect();
      failing.session.revokeAsync.mockRejectedValueOnce(new Error('down'));
      await expect(failing.provider.signOut()).resolves.toBeUndefined();
      expect(failing.store.items.size).toBe(0);

      const noEndpoint = harness({ discovery: { tokenEndpoint: TOKEN_ENDPOINT } });
      await noEndpoint.provider.signInWithRedirect();
      await noEndpoint.provider.signOut();
      expect(noEndpoint.session.revokeAsync).not.toHaveBeenCalled();
      expect(noEndpoint.store.items.size).toBe(0);
    });
  });

  describe('races, failures and edge cases', () => {
    function seeded(overrides: Partial<ExpoAuthProviderConfig> = {}) {
      const h = harness(overrides);
      h.store.items.set('vectros.auth.n', '1');
      h.store.items.set('vectros.auth.0', 'refresh-1');
      return h;
    }

    it('a sign-out that overlaps a rotated-token write deletes and revokes the token that write stored', async () => {
      const { provider, store, session } = seeded();
      session.refreshAsync.mockResolvedValueOnce(tokenResponse({ refreshToken: 'refresh-2' }));
      // Hold the write of the rotated token inside the secure store.
      let releaseWrite!: () => void;
      const writeGate = new Promise<void>((r) => (releaseWrite = r));
      const realSet = store.setItemAsync.getMockImplementation()!;
      store.setItemAsync.mockImplementationOnce(async (key: string, value: string) => {
        await writeGate;
        await realSet(key, value);
      });
      const refreshing = provider.getIdToken();
      await vi.waitFor(() => expect(store.setItemAsync).toHaveBeenCalled());
      const signingOut = provider.signOut();
      releaseWrite();
      await Promise.all([refreshing, signingOut]);
      expect(store.items.size).toBe(0);
      await vi.waitFor(() =>
        expect(session.revokeAsync).toHaveBeenCalledWith({ clientId: 'client-1', token: 'refresh-2' }, DISCOVERY),
      );
      expect(await provider.getCurrentUser()).toBeNull();
    });

    it('a sign-out whose delete the secure store refuses throws, and nothing restores the session meanwhile', async () => {
      const { provider, store, session } = harness();
      await provider.signInWithRedirect();
      store.deleteItemAsync.mockRejectedValueOnce(new Error('keychain locked'));
      await expect(provider.signOut()).rejects.toMatchObject({ message: 'Secure storage failed: keychain locked' });
      // The token is still on the device, but this process never restores from it...
      expect(store.items.get('vectros.auth.0')).toBe('refresh-1');
      expect(await provider.getCurrentUser()).toBeNull();
      expect(session.refreshAsync).not.toHaveBeenCalled();
      // ...and that call retried the delete, which now succeeds and revokes the token.
      expect(store.items.size).toBe(0);
      await vi.waitFor(() =>
        expect(session.revokeAsync).toHaveBeenCalledWith({ clientId: 'client-1', token: 'refresh-1' }, DISCOVERY),
      );
    });

    it('a sign-out whose read fails still deletes the stored token (it just cannot revoke it)', async () => {
      const { provider, store, session } = harness();
      await provider.signInWithRedirect();
      store.getItemAsync.mockRejectedValueOnce(new Error('keychain read failed'));
      await provider.signOut();
      expect(store.items.size).toBe(0);
      expect(session.revokeAsync).not.toHaveBeenCalled();
    });

    it('a sign-out during a rotating refresh revokes the rotated token, which was never stored', async () => {
      const { provider, store, session } = seeded();
      let release!: (t: ExpoTokenResponse) => void;
      session.refreshAsync.mockImplementationOnce(() => new Promise<ExpoTokenResponse>((r) => (release = r)));
      const pending = provider.getIdToken();
      await vi.waitFor(() => expect(session.refreshAsync).toHaveBeenCalled());
      await provider.signOut();
      release(tokenResponse({ refreshToken: 'rotated' }));
      await pending;
      await vi.waitFor(() =>
        expect(session.revokeAsync).toHaveBeenCalledWith({ clientId: 'client-1', token: 'rotated' }, DISCOVERY),
      );
      expect(store.items.size).toBe(0);
    });

    it('a failed secure-store write at sign-in revokes the refresh token it could not store', async () => {
      const { provider, store, session } = harness();
      store.setItemAsync.mockRejectedValueOnce(new Error('keychain locked'));
      await expect(provider.signInWithRedirect()).rejects.toBeInstanceOf(AuthError);
      await vi.waitFor(() =>
        expect(session.revokeAsync).toHaveBeenCalledWith({ clientId: 'client-1', token: 'refresh-1' }, DISCOVERY),
      );
    });

    it('refuses an exchange endpoint that is not https (loopback http is allowed)', () => {
      expect(() => harness({ exchangeEndpoint: 'http://api.example.com/v1/auth/token/exchange' })).toThrow(/https/);
      expect(() => harness({ exchangeEndpoint: 'not a url' })).toThrow(/not a URL/);
      expect(() => harness({ exchangeEndpoint: 'http://localhost:8080/v1/auth/token/exchange' })).not.toThrow();
    });

    it('sign-out completes without waiting for revocation', async () => {
      const { provider, store, session } = harness();
      await provider.signInWithRedirect();
      session.revokeAsync.mockImplementationOnce(() => new Promise<boolean>(() => undefined));
      await provider.signOut();
      expect(store.items.size).toBe(0);
      expect(await provider.getCurrentUser()).toBeNull();
    });

    it('a sign-out during sign-in wins: the sign-in is refused and its refresh token revoked', async () => {
      const { provider, store, session } = harness();
      let release!: (t: ExpoTokenResponse) => void;
      session.exchangeCodeAsync.mockImplementationOnce(() => new Promise<ExpoTokenResponse>((r) => (release = r)));
      const signingIn = provider.signInWithRedirect();
      await vi.waitFor(() => expect(session.exchangeCodeAsync).toHaveBeenCalled());
      await provider.signOut();
      release(tokenResponse({ refreshToken: 'late' }));
      await expect(signingIn).rejects.toMatchObject({ message: 'Sign-in was cancelled.' });
      expect(store.items.size).toBe(0);
      await vi.waitFor(() =>
        expect(session.revokeAsync).toHaveBeenCalledWith({ clientId: 'client-1', token: 'late' }, DISCOVERY),
      );
    });

    it('a new sign-in and a sign-out each forget the Vectros bearers cached for the previous user', async () => {
      __resetVectrosApiTokenCacheForTest();
      let n = 0;
      setPartnerApiTokenMinter(async () => ({ token: `st_${(n += 1)}`, expiresAtMs: Date.now() + 900_000 }));
      const { provider } = harness();
      const first = await getVectrosApiToken('app');
      await provider.signInWithRedirect();
      const second = await getVectrosApiToken('app');
      expect(second).not.toBe(first);
      await provider.signOut();
      expect(await getVectrosApiToken('app')).not.toBe(second);
      __resetVectrosApiTokenCacheForTest();
    });

    it('relaunch: a refresh without an ID token ends the session with a clear error instead of refreshing on every call', async () => {
      const { provider, store, session } = seeded();
      const { idToken: _omitted, ...noId } = tokenResponse({ refreshToken: 'refresh-2' });
      session.refreshAsync.mockResolvedValue(noId);
      await expect(provider.exchangeToken()).rejects.toThrow(/no ID token/);
      expect(store.items.size).toBe(0);
      expect(await provider.getCurrentUser()).toBeNull();
      expect(session.refreshAsync).toHaveBeenCalledTimes(1);
    });

    it('in process: a refresh without an ID token keeps the previous one while it is still valid', async () => {
      const { provider, session } = harness({ subjectToken: 'access_token' });
      session.exchangeCodeAsync.mockResolvedValueOnce(tokenResponse({ expiresIn: 30 }));
      await provider.signInWithRedirect();
      const { idToken: _omitted, ...noId } = tokenResponse();
      session.refreshAsync.mockResolvedValueOnce(noId);
      expect((await provider.getCurrentUser())?.sub).toBe('user-1');
      expect(session.refreshAsync).toHaveBeenCalledTimes(1);
    });

    it('a device clock far ahead of the server does not make every call refresh', async () => {
      const { provider, session } = harness();
      // Tokens issued "two hours ago" by the device clock, each with a one-hour lifetime.
      const skewed = nowSec() - 7200;
      session.exchangeCodeAsync.mockResolvedValueOnce(
        tokenResponse({ idToken: idToken({ iat: skewed, exp: skewed + 3600 }), expiresIn: 3600, issuedAt: skewed }),
      );
      await provider.signInWithRedirect();
      await provider.getIdToken();
      await provider.getIdToken();
      expect(session.refreshAsync).not.toHaveBeenCalled();
    });

    it('with no stated lifetime anywhere, the session is treated as short-lived rather than permanent', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const { provider, session } = harness();
      const { expiresIn: _e, ...noLifetime } = tokenResponse({ idToken: jwt({ sub: 'user-1', email: 'a@example.com' }) });
      session.exchangeCodeAsync.mockResolvedValueOnce({ ...noLifetime, accessToken: 'opaque' });
      await provider.signInWithRedirect();
      await provider.getIdToken();
      expect(session.refreshAsync).not.toHaveBeenCalled();
      vi.setSystemTime(Date.now() + 5 * 60_000);
      await provider.getIdToken();
      expect(session.refreshAsync).toHaveBeenCalledTimes(1);
    });

    it('a failed write of a rotated token keeps the in-memory session', async () => {
      const { provider, store, session } = seeded();
      session.refreshAsync.mockResolvedValueOnce(tokenResponse({ refreshToken: 'refresh-2' }));
      store.setItemAsync.mockRejectedValueOnce(new Error('User interaction is not allowed.'));
      expect((await provider.getCurrentUser())?.sub).toBe('user-1');
    });

    it('a failed secure-store write at sign-in is an AuthError and leaves no session', async () => {
      const { provider, store } = harness();
      store.setItemAsync.mockRejectedValueOnce(new Error('keychain locked'));
      await expect(provider.signInWithRedirect()).rejects.toMatchObject({
        code: 'UNKNOWN',
        message: 'Secure storage failed: keychain locked',
      });
      expect(await provider.getCurrentUser()).toBeNull();
    });

    it('a failed secure-store read surfaces as an AuthError from the exchange', async () => {
      const { provider, store } = harness();
      store.getItemAsync.mockRejectedValueOnce(new Error('keychain locked'));
      await expect(provider.exchangeToken()).rejects.toMatchObject({ message: 'Secure storage failed: keychain locked' });
    });

    it('an interrupted write reads as no session, and the next delete clears its orphaned chunks', async () => {
      const { provider, store } = harness();
      store.items.set('vectros.auth.0', 'half-written');
      store.items.set('vectros.auth.1', 'chunk');
      expect(await provider.getCurrentUser()).toBeNull();
      await provider.signOut();
      expect(store.items.size).toBe(0);
    });

    it('passes keychainAccessible to every secure-store call', async () => {
      const { provider, store } = harness({ keychainAccessible: 0 });
      await provider.signInWithRedirect();
      for (const call of [...store.setItemAsync.mock.calls, ...store.getItemAsync.mock.calls, ...store.deleteItemAsync.mock.calls]) {
        expect(call.at(-1)).toEqual({ keychainAccessible: 0 });
      }
    });

    it('reports a second concurrent sign-in as such, not as a cancellation', async () => {
      const { provider, session } = harness();
      session.promptResult = { type: 'locked' };
      await expect(provider.signInWithRedirect()).rejects.toMatchObject({ message: 'Another sign-in is already in progress.' });
    });

    it('maps a promptAsync that throws, and a sign-in that returns no ID token', async () => {
      const { provider, session } = harness();
      session.promptError = new Error('No browser available');
      await expect(provider.signInWithRedirect()).rejects.toMatchObject({ code: 'UNKNOWN', message: 'No browser available' });
      session.promptError = null;
      const { idToken: _omitted, ...noId } = tokenResponse();
      session.exchangeCodeAsync.mockResolvedValueOnce(noId);
      await expect(provider.signInWithRedirect()).rejects.toThrow(/no ID token/);
    });

    it('a failed discovery fetch is retried on the next call, not cached', async () => {
      const { provider, session } = harness();
      session.fetchDiscoveryAsync.mockRejectedValueOnce(new TypeError('Network request failed'));
      await expect(provider.signInWithRedirect()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
      await provider.signInWithRedirect();
      expect(session.fetchDiscoveryAsync).toHaveBeenCalledTimes(2);
    });

    it('getAccessToken returns the identity provider access token', async () => {
      const { provider } = harness();
      expect(await provider.getAccessToken()).toBeNull();
      await provider.signInWithRedirect();
      expect(decodeJwtClaims((await provider.getAccessToken()) as string)?.['aud']).toBe('https://api.example.com');
    });
  });

  describe('through <AuthProvider>', () => {
    function Probe() {
      const { user, loading, signInWithRedirect, handleRedirectCallback } = useAuth();
      return createElement(
        'div',
        null,
        createElement('span', { 'data-testid': 'user' }, loading ? 'loading' : (user?.email ?? 'signed-out')),
        createElement(
          'button',
          {
            onClick: async () => {
              await signInWithRedirect?.();
              await handleRedirectCallback?.();
            },
          },
          'sign in',
        ),
      );
    }

    it('restores the stored session at mount', async () => {
      const { provider, store } = harness();
      store.items.set('vectros.auth.n', '1');
      store.items.set('vectros.auth.0', 'refresh-1');
      render(createElement(AuthProvider, { provider, children: createElement(Probe) }));
      expect(await screen.findByText('ada@example.com')).toBeInTheDocument();
    });

    it('signInWithRedirect then handleRedirectCallback shows the signed-in user', async () => {
      const { provider } = harness();
      render(createElement(AuthProvider, { provider, children: createElement(Probe) }));
      expect(await screen.findByText('signed-out')).toBeInTheDocument();
      await act(async () => {
        screen.getByText('sign in').click();
      });
      expect(await screen.findByText('ada@example.com')).toBeInTheDocument();
    });
  });

  describe('the Vectros exchange', () => {
    it('exchanges the ID token when configured with id_token', async () => {
      const { provider } = harness();
      await provider.signInWithRedirect();
      const minted = await provider.mintPartnerApiToken(undefined, 'ctx-1');
      expect(minted.token).toBe('st_minted');
      expect(minted.resolvedScope.allowedActions).toEqual(['records:r']);
      const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as Record<string, string>;
      expect(body).toMatchObject({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        context_id: 'ctx-1',
      });
      expect(decodeJwtClaims(body['subject_token'] as string)?.['email']).toBe('ada@example.com');
    });

    it('exchanges the access token when configured with access_token', async () => {
      const { provider } = harness({ subjectToken: 'access_token' });
      await provider.signInWithRedirect();
      await provider.exchangeToken();
      const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as Record<string, string>;
      expect(decodeJwtClaims(body['subject_token'] as string)?.['aud']).toBe('https://api.example.com');
    });

    it('throws INVALID_CREDENTIALS with no session, without calling the endpoint', async () => {
      const { provider } = harness();
      await expect(provider.mintPartnerApiToken()).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('the cache-driven mint does not retry a 403 itself; acceptInvite forwards the invite and does not retry either', async () => {
      const { provider } = harness();
      await provider.signInWithRedirect();
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 403 }));
      await expect(provider.mintPartnerApiToken()).rejects.toBeInstanceOf(AuthError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await expect(provider.acceptInvite('inv-1')).rejects.toThrow(/403 invalid_grant/);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const body = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string) as Record<string, string>;
      expect(body['invite_token']).toBe('inv-1');
    });

    it('a direct exchange retries one 403 once', async () => {
      vi.useFakeTimers();
      const { provider } = harness();
      await provider.signInWithRedirect();
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 403 })).mockResolvedValueOnce(okExchange());
      const pending = provider.exchangeToken({ signupType: 'member' });
      await vi.runAllTimersAsync();
      expect((await pending).token).toBe('st_minted');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('decodeJwtClaims', () => {
    it('decodes non-ASCII claims without atob or TextDecoder', () => {
      vi.stubGlobal('atob', undefined);
      vi.stubGlobal('TextDecoder', undefined);
      expect(decodeJwtClaims(jwt({ name: 'Zoë Ångström ✓' }))).toEqual({ name: 'Zoë Ångström ✓' });
    });

    it('tolerates padding and standard-alphabet characters', () => {
      const payload = Buffer.from(JSON.stringify({ s: '??>>' }), 'utf8').toString('base64');
      expect(decodeJwtClaims(`a.${payload}.c`)).toEqual({ s: '??>>' });
    });

    it('returns null for something that is not a JWT', () => {
      expect(decodeJwtClaims('opaque-token')).toBeNull();
      expect(decodeJwtClaims('a.!!!.c')).toBeNull();
      expect(decodeJwtClaims(`a.${b64url('[1,2]')}.c`)).toBeNull();
      expect(decodeJwtClaims('a.e.c')).toBeNull();
    });
  });
});
