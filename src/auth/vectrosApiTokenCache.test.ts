// ---------------------------------------------------------------------------
// vectrosApiTokenCache tests.
//
// Covers the base (tenant, context) mint path (caching, refresh-before-expiry,
// concurrent-mint coalescing, retry-after-failure) and the identity-override
// path (`POST /v1/auth/token/assume`) — a SEPARATE cache slot per (tenant,
// context, namespace, value) that resolves the base bearer first (sharing ITS
// cache slot/coalescing) and then exchanges it via the injected assumer.
//
// Also guards a real regression: a mint that rejects synchronously relative
// to its own start (no `await` before the throw) could permanently poison its
// cache slot, because the in-flight promise's self-referential cleanup guard
// ran before the outer `mintPromise` variable — and the
// `inFlightMints.set(key, mintPromise)` call right after it — had even
// executed. "Minter not registered yet" is the one real-world way to trigger
// a zero-await rejection: a gated component can render (and call
// getVectrosApiToken) before app boot's setPartnerApiTokenMinter() has run.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __resetVectrosApiTokenCacheForTest,
  clearVectrosApiTokenCache,
  getVectrosApiToken,
  setPartnerApiTokenMinter,
  setPartnerApiTokenAssumer,
} from './vectrosApiTokenCache';

/** A Promise plus its resolve/reject, for controlling exactly when a mock mint settles. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const FAR_FUTURE = Date.now() + 10 * 60_000; // 10 min out — well outside the 60s refresh window
const NEAR_EXPIRY = Date.now() + 30_000; // inside the 60s refresh window — treated as "needs refresh"

afterEach(() => {
  __resetVectrosApiTokenCacheForTest();
  vi.restoreAllMocks();
});

describe('getVectrosApiToken — base (tenant, context) path', () => {
  it('rejects when tenantId is falsy', async () => {
    await expect(getVectrosApiToken('')).rejects.toThrow(/tenantId is required/);
  });

  it('throws when no minter is registered', async () => {
    await expect(getVectrosApiToken('tnt_a')).rejects.toThrow(/minter not registered/);
  });

  it('a mint attempted before the minter is registered does NOT permanently poison the slot — the whole point of the regression this file guards', async () => {
    // The exact real-world shape: something calls getVectrosApiToken (e.g. a
    // gated nav item's ScopeGate mounting) before app boot has registered a
    // minter yet.
    await expect(getVectrosApiToken('tnt_a')).rejects.toThrow(/minter not registered/);

    // The minter registers moments later (app boot's normal ordering catches
    // up). A subsequent call for the SAME slot must mint for real — not keep
    // rejecting from a dead, orphaned in-flight promise.
    setPartnerApiTokenMinter(vi.fn().mockResolvedValue({ token: 'st_after_late_register', expiresAtMs: FAR_FUTURE }));

    await expect(getVectrosApiToken('tnt_a')).resolves.toBe('st_after_late_register');
  });

  it('mints once and returns the cached token on a second call', async () => {
    const minter = vi.fn().mockResolvedValue({ token: 'st_a', expiresAtMs: FAR_FUTURE });
    setPartnerApiTokenMinter(minter);

    await expect(getVectrosApiToken('tnt_a')).resolves.toBe('st_a');
    await expect(getVectrosApiToken('tnt_a')).resolves.toBe('st_a');

    expect(minter).toHaveBeenCalledTimes(1);
  });

  it('re-mints once the cached token is within the refresh-before-expiry window', async () => {
    const minter = vi
      .fn()
      .mockResolvedValueOnce({ token: 'st_old', expiresAtMs: NEAR_EXPIRY })
      .mockResolvedValueOnce({ token: 'st_fresh', expiresAtMs: FAR_FUTURE });
    setPartnerApiTokenMinter(minter);

    await expect(getVectrosApiToken('tnt_a')).resolves.toBe('st_old');
    await expect(getVectrosApiToken('tnt_a')).resolves.toBe('st_fresh');

    expect(minter).toHaveBeenCalledTimes(2);
  });

  it('different (tenant, context) slots mint independently', async () => {
    const minter = vi
      .fn()
      .mockResolvedValueOnce({ token: 'st_ctx_a', expiresAtMs: FAR_FUTURE })
      .mockResolvedValueOnce({ token: 'st_ctx_b', expiresAtMs: FAR_FUTURE });
    setPartnerApiTokenMinter(minter);

    await expect(getVectrosApiToken('tnt_a', 'ctxA')).resolves.toBe('st_ctx_a');
    await expect(getVectrosApiToken('tnt_a', 'ctxB')).resolves.toBe('st_ctx_b');
    expect(minter).toHaveBeenCalledTimes(2);
    expect(minter).toHaveBeenNthCalledWith(1, 'tnt_a', 'ctxA');
    expect(minter).toHaveBeenNthCalledWith(2, 'tnt_a', 'ctxB');
  });

  it('concurrent callers for the SAME slot share one in-flight mint', async () => {
    const d = deferred<{ token: string; expiresAtMs: number }>();
    const minter = vi.fn().mockReturnValue(d.promise);
    setPartnerApiTokenMinter(minter);

    const p1 = getVectrosApiToken('tnt_a');
    const p2 = getVectrosApiToken('tnt_a');
    d.resolve({ token: 'st_shared', expiresAtMs: FAR_FUTURE });

    await expect(p1).resolves.toBe('st_shared');
    await expect(p2).resolves.toBe('st_shared');
    expect(minter).toHaveBeenCalledTimes(1);
  });

  it('discards a mint result that resolves AFTER clearVectrosApiTokenCache fired mid-flight', async () => {
    const d = deferred<{ token: string; expiresAtMs: number }>();
    setPartnerApiTokenMinter(vi.fn().mockReturnValue(d.promise));

    const inFlight = getVectrosApiToken('tnt_a');
    clearVectrosApiTokenCache(); // bumps the generation while the mint above is still pending
    d.resolve({ token: 'st_stale', expiresAtMs: FAR_FUTURE });

    await expect(inFlight).rejects.toThrow(/cleared during partner-API token mint/);

    // The discarded token must not have landed in the cache — a fresh mint runs on the next call.
    const minter2 = vi.fn().mockResolvedValue({ token: 'st_after_clear', expiresAtMs: FAR_FUTURE });
    setPartnerApiTokenMinter(minter2);
    await expect(getVectrosApiToken('tnt_a')).resolves.toBe('st_after_clear');
  });

  it('a failed mint retries ONCE internally, within the SAME call — no separate second call needed', async () => {
    // Live-tested 2026-08-26: a token exchange for an identity JUST activated
    // (e.g. right after a successful invite-accept) can still 403 on its very
    // next exchange — a real backend-side race/staleness. This retry lives
    // HERE (not in each individual consumer, e.g. useScopeGate) specifically
    // so every consumer benefits uniformly and so near-concurrent callers can
    // share ONE retry — see the next test. Supersedes an earlier version of
    // this test (2026-08-21) that expected the OLD design — reject on the
    // first call, succeed on a separate second call — before the retry moved
    // inside the same in-flight promise.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let attempt = 0;
    setPartnerApiTokenMinter(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('mint failed');
      return { token: 'st_retry_ok', expiresAtMs: FAR_FUTURE };
    });

    const p = getVectrosApiToken('tnt_a');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(p).resolves.toBe('st_retry_ok');
    expect(attempt).toBe(2);
    vi.useRealTimers();
  });

  it('a mint that fails on BOTH the first attempt and the retry rejects (unchanged degraded case)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let attempt = 0;
    setPartnerApiTokenMinter(async () => {
      attempt += 1;
      throw new Error(`mint failed (attempt ${attempt})`);
    });

    const p = getVectrosApiToken('tnt_a');
    // Attach the rejection expectation synchronously, before any timer
    // advancement — otherwise fake-timer flushing can let `p` reject before
    // anything is listening, which vitest flags as an unhandled rejection
    // even though it's awaited moments later.
    const expectation = expect(p).rejects.toThrow('mint failed (attempt 2)');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);

    await expectation;
    expect(attempt).toBe(2);
    vi.useRealTimers();
  });

  it("the config error 'minter not registered' is NOT retried — it can't self-heal on a ~1.5s timescale", async () => {
    // Distinguishes a genuine mint-attempt failure (retried, tests above)
    // from "not configured yet" (skipped — see getVectrosApiToken's own
    // comment on why retrying this specific case wastes time for nothing).
    const start = Date.now();
    await expect(getVectrosApiToken('tnt_a')).rejects.toThrow(/minter not registered/);
    // Real-clock assertion (no fake timers here) that this returned fast —
    // a wrongly-applied retry would make this take >= SHARED_MINT_RETRY_DELAY_MS.
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('a SECOND caller arriving DURING the retry delay window joins the SAME retry — does not start its own independent mint', async () => {
    // The actual bug this retry-in-the-cache design fixes: several
    // independent UI consumers (e.g. one useScopeGate per gated nav item)
    // each call getVectrosApiToken around the same moment. Before this, each
    // one raced its own fresh mint the instant the FIRST failure cleared the
    // slot — measured live as 2-3 separate 403s for one page load. Now the
    // whole attempt+delay+retry sequence stays as ONE in-flight promise, so
    // a caller arriving mid-delay joins it instead of starting its own.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let attempt = 0;
    setPartnerApiTokenMinter(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('first caller unlucky');
      return { token: 'st_shared_retry', expiresAtMs: FAR_FUTURE };
    });

    const p1 = getVectrosApiToken('tnt_a');
    await vi.advanceTimersByTimeAsync(0); // let the first attempt's rejection land
    await vi.advanceTimersByTimeAsync(500); // still mid-delay (< SHARED_MINT_RETRY_DELAY_MS)
    const p2 = getVectrosApiToken('tnt_a'); // a second, independent consumer's call
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(p1).resolves.toBe('st_shared_retry');
    await expect(p2).resolves.toBe('st_shared_retry');
    // Exactly 2 real mint attempts total (1 failed + 1 shared retry) — NOT 3
    // or 4, which is what independent per-caller racing would have produced.
    expect(attempt).toBe(2);
    vi.useRealTimers();
  });
});

describe('getVectrosApiToken — identity-override path (POST /v1/auth/token/assume)', () => {
  it('throws when no assumer is registered, even though a minter is', async () => {
    setPartnerApiTokenMinter(vi.fn().mockResolvedValue({ token: 'st_base', expiresAtMs: FAR_FUTURE }));

    await expect(getVectrosApiToken('tnt_a', 'default', { namespace: 'scope:org', value: 'orgB' })).rejects.toThrow(
      /assumer not registered/,
    );
  });

  it('resolves the base bearer first, then exchanges it via the assumer', async () => {
    const minter = vi.fn().mockResolvedValue({ token: 'st_base', expiresAtMs: FAR_FUTURE });
    const assumer = vi.fn().mockResolvedValue({ token: 'st_assumed_orgB', expiresAtMs: FAR_FUTURE });
    setPartnerApiTokenMinter(minter);
    setPartnerApiTokenAssumer(assumer);

    const token = await getVectrosApiToken('tnt_a', 'default', { namespace: 'scope:org', value: 'orgB' });

    expect(token).toBe('st_assumed_orgB');
    expect(minter).toHaveBeenCalledTimes(1);
    expect(assumer).toHaveBeenCalledWith('st_base', { namespace: 'scope:org', value: 'orgB' });
  });

  it('caches the assumed bearer SEPARATELY from the base slot — both remain independently readable', async () => {
    const minter = vi.fn().mockResolvedValue({ token: 'st_base', expiresAtMs: FAR_FUTURE });
    const assumer = vi.fn().mockResolvedValue({ token: 'st_assumed_orgB', expiresAtMs: FAR_FUTURE });
    setPartnerApiTokenMinter(minter);
    setPartnerApiTokenAssumer(assumer);

    const override = { namespace: 'scope:org', value: 'orgB' };
    await expect(getVectrosApiToken('tnt_a', 'default', override)).resolves.toBe('st_assumed_orgB');
    // Base slot, no override — must still read the ORIGINAL base token, not the assumed one.
    await expect(getVectrosApiToken('tnt_a', 'default')).resolves.toBe('st_base');

    // Cached — a second call for either slot must not re-mint/re-assume.
    await expect(getVectrosApiToken('tnt_a', 'default', override)).resolves.toBe('st_assumed_orgB');
    expect(minter).toHaveBeenCalledTimes(1);
    expect(assumer).toHaveBeenCalledTimes(1);
  });

  it('two different override values get two independent cache slots', async () => {
    setPartnerApiTokenMinter(vi.fn().mockResolvedValue({ token: 'st_base', expiresAtMs: FAR_FUTURE }));
    const assumer = vi
      .fn()
      .mockResolvedValueOnce({ token: 'st_orgB', expiresAtMs: FAR_FUTURE })
      .mockResolvedValueOnce({ token: 'st_orgC', expiresAtMs: FAR_FUTURE });
    setPartnerApiTokenAssumer(assumer);

    await expect(
      getVectrosApiToken('tnt_a', 'default', { namespace: 'scope:org', value: 'orgB' }),
    ).resolves.toBe('st_orgB');
    await expect(
      getVectrosApiToken('tnt_a', 'default', { namespace: 'scope:org', value: 'orgC' }),
    ).resolves.toBe('st_orgC');
    expect(assumer).toHaveBeenCalledTimes(2);
  });

  it('concurrent callers for the SAME override slot share one in-flight assume', async () => {
    setPartnerApiTokenMinter(vi.fn().mockResolvedValue({ token: 'st_base', expiresAtMs: FAR_FUTURE }));
    const d = deferred<{ token: string; expiresAtMs: number }>();
    const assumer = vi.fn().mockReturnValue(d.promise);
    setPartnerApiTokenAssumer(assumer);

    const override = { namespace: 'scope:org', value: 'orgB' };
    const p1 = getVectrosApiToken('tnt_a', 'default', override);
    const p2 = getVectrosApiToken('tnt_a', 'default', override);
    d.resolve({ token: 'st_assumed', expiresAtMs: FAR_FUTURE });

    await expect(p1).resolves.toBe('st_assumed');
    await expect(p2).resolves.toBe('st_assumed');
    expect(assumer).toHaveBeenCalledTimes(1);
  });

  it('clearVectrosApiTokenCache clears override slots too', async () => {
    const minter = vi.fn().mockResolvedValue({ token: 'st_base', expiresAtMs: FAR_FUTURE });
    const assumer = vi.fn().mockResolvedValue({ token: 'st_orgB', expiresAtMs: FAR_FUTURE });
    setPartnerApiTokenMinter(minter);
    setPartnerApiTokenAssumer(assumer);

    const override = { namespace: 'scope:org', value: 'orgB' };
    await getVectrosApiToken('tnt_a', 'default', override);
    clearVectrosApiTokenCache();
    await getVectrosApiToken('tnt_a', 'default', override);

    expect(minter).toHaveBeenCalledTimes(2);
    expect(assumer).toHaveBeenCalledTimes(2);
  });
});
