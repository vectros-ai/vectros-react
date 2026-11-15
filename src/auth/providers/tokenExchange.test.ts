import { afterEach, describe, expect, it, vi } from 'vitest';

import { EXCHANGE_TIMEOUT_MS, assertExchangeEndpoint, exchangeSubjectToken, parseRetryAfterSeconds } from './tokenExchange';

const ENDPOINT = 'https://api.example.com/v1/auth/token/exchange';

describe('exchangeSubjectToken: the success body', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('a 200 that is not JSON is an AuthError, not a crash', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>gateway</html>', { status: 200 })));
    await expect(exchangeSubjectToken(ENDPOINT, 'jwt')).rejects.toMatchObject({
      code: 'UNKNOWN',
      message: 'Token exchange returned 200 without a token.',
    });
  });

  it.each([
    ['missing', {}],
    ['zero', { expires_in: 0 }],
    ['a string', { expires_in: '900' }],
    ['NaN-producing', { expires_in: null }],
  ])('a %s expires_in is refused rather than cached as already expired', async (_label, extra) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ access_token: 'st_x', ...extra }), { status: 200 })),
    );
    await expect(exchangeSubjectToken(ENDPOINT, 'jwt')).rejects.toThrow(/without a valid expires_in/);
  });

  it('a request that hangs is abandoned as a NETWORK_ERROR after the timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
          }),
      ),
    );
    const pending = exchangeSubjectToken(ENDPOINT, 'jwt');
    const assertion = expect(pending).rejects.toMatchObject({ code: 'NETWORK_ERROR', message: 'Token exchange request timed out.' });
    await vi.advanceTimersByTimeAsync(EXCHANGE_TIMEOUT_MS);
    await assertion;
  });
});

describe('exchangeSubjectToken: a 429', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const limited = (headers: Record<string, string>): Response =>
    new Response(JSON.stringify({ error: 'temporarily_unavailable' }), { status: 429, headers });

  it('is LIMIT_EXCEEDED carrying the Retry-After seconds, and is not retried', async () => {
    const fetchMock = vi.fn(async () => limited({ 'Retry-After': '42' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(exchangeSubjectToken(ENDPOINT, 'jwt')).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
      retryAfterSeconds: 42,
      message: 'Token exchange is rate limited; retry after 42 s.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('without a Retry-After header is still LIMIT_EXCEEDED, with no wait', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => limited({})));
    const err = await exchangeSubjectToken(ENDPOINT, 'jwt').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'LIMIT_EXCEEDED', message: 'Token exchange is rate limited.' });
    expect((err as { retryAfterSeconds?: number }).retryAfterSeconds).toBeUndefined();
  });

  it('a 403 is still UNKNOWN (only a 429 is a rate limit)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 403 })));
    await expect(exchangeSubjectToken(ENDPOINT, 'jwt', { skipOwnRetry: true })).rejects.toMatchObject({ code: 'UNKNOWN' });
  });
});

describe('parseRetryAfterSeconds', () => {
  const NOW = Date.parse('2026-11-11T12:00:00Z');

  it.each([
    ['30', 30],
    [' 7 ', 7],
    ['0', 0],
    ['Wed, 11 Nov 2026 12:01:30 GMT', 90],
    ['Wed, 11 Nov 2026 11:59:00 GMT', 0],
  ])('reads %j as %d seconds', (value, seconds) => {
    expect(parseRetryAfterSeconds(value, NOW)).toBe(seconds);
  });

  it.each([[null], [''], ['-5'], ['1.5'], ['soon'], ['9'.repeat(400)]])('reads %j as no value', (value) => {
    expect(parseRetryAfterSeconds(value, NOW)).toBeUndefined();
  });
});

describe('assertExchangeEndpoint', () => {
  it.each(['https://api.example.com/x', 'http://localhost:3000/x', 'http://127.0.0.1/x', 'http://[::1]:8080/x'])(
    'accepts %s',
    (url) => {
      expect(() => assertExchangeEndpoint(url)).not.toThrow();
    },
  );

  it.each(['http://api.example.com/x', 'ftp://api.example.com/x', 'api.example.com/x'])('refuses %s', (url) => {
    expect(() => assertExchangeEndpoint(url)).toThrow();
  });
});
