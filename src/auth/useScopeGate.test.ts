// ---------------------------------------------------------------------------
// useScopeGate tests.
//
// canPerform is the ops-aware capability PREDICATE — pinned directly, no
// mint/token machinery involved (see its own describe block below).
//
// The hook itself (loading → resolved, identity, mint-retry recovery) is
// exercised via the REAL getVectrosApiToken/getVectrosResolvedScope/
// setPartnerApiTokenMinter seam (vectrosApiTokenCache.ts), not a mocked
// module — same idiom vectrosApiTokenCache.test.ts uses.
// useScopeGate reads the mint response's server-resolved `resolvedScope`
// field directly; it no longer decodes a token client-side at all (that
// machinery — decodeAllowedActions/decodeIdentity/scopeCompression.ts — was
// retired in the same change, see this file's own history for the decode
// tests that used to live here).
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, test, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

import { OPS_LETTERS, canPerform, isOpsString, useScopeGate } from './useScopeGate';
import { __resetVectrosApiTokenCacheForTest, setPartnerApiTokenMinter } from './vectrosApiTokenCache';

// -----------------------------------------------------------------------------
// canPerform — the ops-aware capability check. Not credential-shape-exhaustive
// on its own (that lives at the consumer, per-surface) — this pins the
// PREDICATE's own contract: what it unions, what it deliberately refuses to
// union, and that it never gets wider than what the caller can prove.
// -----------------------------------------------------------------------------
describe('canPerform', () => {
  test('wildcard grants everything', () => {
    expect(canPerform(['*'], 'users:cru')).toBe(true);
    expect(canPerform(['*'], 'anything:at:all')).toBe(true);
  });

  test('a single combined entry satisfies a narrower ask', () => {
    expect(canPerform(['users:cru'], 'users:r')).toBe(true);
    expect(canPerform(['users:cru'], 'users:ru')).toBe(true);
  });

  test('ops split across separate entries union — the shape a multi-row profile authors', () => {
    expect(canPerform(['users:c', 'users:r', 'users:u'], 'users:ru')).toBe(true);
    // Missing 'u' — only c+r granted.
    expect(canPerform(['users:c', 'users:r'], 'users:ru')).toBe(false);
  });

  test('different resources never leak into each other', () => {
    expect(canPerform(['keys:r'], 'users:r')).toBe(false);
  });

  test('a qualified grant does NOT satisfy an unqualified ask (no widening)', () => {
    // records:r:foo proves the caller can read records qualified to "foo" —
    // NOT that they can read records generally. Must not be unioned in.
    expect(canPerform(['records:r:foo'], 'records:r')).toBe(false);
  });

  test('an unqualified grant DOES satisfy the SAME qualified ask via exact-match fallback only', () => {
    // The asked action itself carries a qualifier (3 segments) — canPerform
    // falls back to exact string match rather than reasoning about whether
    // the qualifier applies. An unqualified users:r grant does not literally
    // equal 'users:r:foo', so this is denied — a deliberately conservative
    // "not a decision this predicate makes" rather than a guess.
    expect(canPerform(['users:r'], 'users:r:foo')).toBe(false);
  });

  test('a combined qualified entry satisfies a narrower SAME-qualifier ask', () => {
    // The exact shape a role's `allowedActions: [records:crud:case]` clause
    // produces — measured live against a real deployment, where a gated nav
    // item stayed silently hidden because this case fell through to
    // exact-match denial.
    expect(canPerform(['records:crud:case'], 'records:r:case')).toBe(true);
    expect(canPerform(['records:crud:case'], 'records:cr:case')).toBe(true);
    expect(canPerform(['records:crud:case'], 'records:crud:case')).toBe(true);
  });

  test('qualified ops split across separate entries union — same qualifier only', () => {
    expect(canPerform(['records:c:case', 'records:r:case'], 'records:cr:case')).toBe(true);
    // Missing 'u' on this qualifier.
    expect(canPerform(['records:c:case', 'records:r:case'], 'records:cru:case')).toBe(false);
  });

  test('a qualified grant never leaks into a DIFFERENT qualifier — no cross-instance widening', () => {
    // records:crud:case must not satisfy an ask qualified to a different
    // resource instance ("note") — same danger the module doc's "qualified
    // grant into unqualified ask" warning names, one level narrower.
    expect(canPerform(['records:crud:case'], 'records:r:note')).toBe(false);
    // Two DIFFERENT qualifiers' ops must not blend into a third ask either.
    expect(canPerform(['records:c:case', 'records:r:note'], 'records:cr:case')).toBe(false);
  });

  test('a legacy/unauthorable-shaped string never spuriously matches via partial ops parsing', () => {
    // 'admin:users' — ops segment "users" contains 'e', which is not a
    // recognized ops letter, so the WHOLE entry is excluded from unioning
    // (not partially parsed for the 'u'/'s' letters it happens to contain).
    expect(canPerform(['admin:users'], 'admin:u')).toBe(false);
    expect(canPerform(['admin:users'], 'admin:s')).toBe(false);
    // Exact-match fallback still recognizes the literal string, unchanged
    // backward-compat behavior for anything already carrying it verbatim.
    expect(canPerform(['admin:users'], 'admin:users')).toBe(true);
  });

  test('a bare custom verb (no colon) matches only verbatim', () => {
    expect(canPerform(['read'], 'read')).toBe(true);
    expect(canPerform(['read'], 'write')).toBe(false);
  });

  test('an ask for a resource with no matching grant at all is denied', () => {
    expect(canPerform([], 'users:r')).toBe(false);
    expect(canPerform(['logs:r'], 'users:r')).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // The `x` (execute) op letter.
  //
  // Cells are labelled EVIDENCE or PINS. An EVIDENCE cell fails against an
  // ops-letter set lacking `x` and so proves the fix; a PINS cell passes either
  // way and is here to hold a documented promise still, not to demonstrate
  // anything. Both are worth keeping and only one is worth citing — an earlier
  // version of this block claimed every cell was the first kind, which was
  // wrong for five of them.
  // ---------------------------------------------------------------------------
  test('a combined entry carrying x satisfies a narrower x ask', () => {
    expect(canPerform(['scripts:cx'], 'scripts:x')).toBe(true); // EVIDENCE
    expect(canPerform(['scripts:crx'], 'scripts:cx')).toBe(true); // EVIDENCE
  });

  test('x unions across separate entries, like every other op letter', () => {
    expect(canPerform(['scripts:c', 'scripts:x'], 'scripts:cx')).toBe(true); // EVIDENCE
    // Missing 'r' — only c+x granted.
    expect(canPerform(['scripts:c', 'scripts:x'], 'scripts:crx')).toBe(false); // PINS
  });

  test('a grant that merely MENTIONS x no longer poisons asks for its other letters', () => {
    // The sharp end of an unrecognized letter: `scripts:rx` stops parsing as an
    // ops string entirely, so it contributes nothing to the union and an ask for
    // the wholly unrelated `r` it grants falls through to an exact-match denial.
    // A credential is told it cannot read scripts because it can also execute
    // them.
    expect(canPerform(['scripts:rx'], 'scripts:r')).toBe(true); // EVIDENCE
    expect(canPerform(['scripts:rx'], 'scripts:x')).toBe(true); // EVIDENCE
    // Still nothing it was not granted.
    expect(canPerform(['scripts:rx'], 'scripts:c')).toBe(false); // PINS
  });

  test('the plainest execute grant answers the plainest execute ask', () => {
    // PINS, and deliberately so: the exact-string fallback already answered this
    // correctly before the fix, which is exactly why the defect looked narrower
    // than it was. It is the feature's happy path and the shape a consumer will
    // write first, so it should not depend on a fallback nobody is watching.
    expect(canPerform(['scripts:x'], 'scripts:x')).toBe(true);
    expect(canPerform(['*'], 'scripts:x')).toBe(true);
    expect(canPerform([], 'scripts:x')).toBe(false);
  });

  test('a per-script grant does NOT satisfy a bare execute ask either', () => {
    // PINS the mirror image, and the reason the doc does not simply say "gate on
    // the bare form": a credential issued exactly one script answers false to
    // "can you execute scripts at all", where the platform answers true. Gating
    // a Scripts surface on the bare ask alone hides it from the caller the
    // per-script grant exists for.
    expect(canPerform(['scripts:x:daily-report'], 'scripts:x')).toBe(false);
  });

  test('a bare execute grant does NOT satisfy a per-script ask', () => {
    // PINS the documented divergence from the API, which is wider here: a bare
    // `scripts:x` covers every script, and the platform's authorizer answers
    // true to a qualified ask against it. This predicate answers false, because
    // an unqualified grant never feeds a qualified ask. Gate a "can execute
    // scripts at all" surface on the bare form. Asserted here because it lives
    // otherwise only in prose, and prose is what a later refactor overrules.
    expect(canPerform(['scripts:x'], 'scripts:x:daily-report')).toBe(false);
  });

  test('a qualified x grant unions and confines like any other qualified grant', () => {
    // `scripts:x:<name>` — the per-script execute grant. Note there is no
    // combined-qualified shape to test on `scripts`: `scripts:cx:<name>` is
    // refused at authoring as mixed, since the qualifier is meaningful for `x`
    // alone. `records` takes a qualifier on every op, so it carries the
    // combined-qualified EVIDENCE cell instead.
    expect(canPerform(['records:crudx:patient'], 'records:x:patient')).toBe(true); // EVIDENCE
    expect(canPerform(['scripts:x:daily-report'], 'scripts:x:daily-report')).toBe(true); // PINS
    expect(canPerform(['scripts:x:daily-report'], 'scripts:x:month-end')).toBe(false); // PINS
    expect(canPerform(['scripts:x:daily-report'], 'scripts:x')).toBe(false); // PINS
  });

  test('x does not leak between resources, and CRUD grants do not satisfy an x ask', () => {
    // Named for what these cells actually prove. They do NOT prove "x widens
    // nothing on a gated resource" — it does widen one thing there, asserted
    // below, and a test name claiming otherwise would be read as a guarantee.
    expect(canPerform(['records:x'], 'records:r')).toBe(false); // PINS
    expect(canPerform(['records:crud'], 'records:x')).toBe(false); // PINS
    expect(canPerform(['scripts:x'], 'records:x')).toBe(false); // PINS
  });

  test('x on a resource that ignores it is answered, not withheld — matching the platform', () => {
    // EVIDENCE, and the one place this change genuinely answers `true` where it
    // used to answer `false` outside `scripts`. The letter is grammatically
    // valid everywhere and acts only on `scripts`, so `records:x` authors
    // cleanly and grants nothing; no gate ever asks it. Mirroring the
    // authorizer's own answer is the correct behaviour, and pretending
    // otherwise would be this predicate inventing a rule the platform does not
    // have.
    expect(canPerform(['records:rx'], 'records:x')).toBe(true);
  });

  test('the NEXT unknown letter degrades exactly the way this one did', () => {
    // PINS the shape the conformance guard exists to catch, so the degradation
    // is documented rather than rediscovered. `z` is not an op letter; a grant
    // carrying it stops parsing as an ops string, and the ask falls to exact
    // matching — which answers correctly for an identical spelling and wrongly
    // for every other one. When this cell starts failing, a letter was added to
    // the platform and this package has not caught up.
    expect(canPerform(['scripts:xz'], 'scripts:xz')).toBe(true); // the misleading one
    expect(canPerform(['scripts:xz'], 'scripts:x')).toBe(false); // the real cost
  });
});

// -----------------------------------------------------------------------------
// The ops-letter set itself. Module-exported for the SDK conformance guard in
// scopeGrammar.sdkContract.test.ts, which asserts it against the platform's own
// published description; pinned here only for its shape, since asserting its
// VALUE against a literal written in this repository is the same-language trap
// that guard exists to escape.
// -----------------------------------------------------------------------------
describe('isOpsString', () => {
  test('accepts a non-empty string of recognized letters and nothing else', () => {
    for (const letter of OPS_LETTERS) expect(isOpsString(letter)).toBe(true);
    expect(isOpsString(OPS_LETTERS)).toBe(true);
    expect(isOpsString('')).toBe(false);
    expect(isOpsString('users')).toBe(false); // one stray letter disqualifies the whole segment
    expect(isOpsString('C')).toBe(false); // case-sensitive, matching the platform
  });
});

// -----------------------------------------------------------------------------
// useScopeGate — loading/resolved state, identity, and the mint-retry
// recovery observed through a failure+recovery cycle.
//
// The one-shot retry that makes this recover no longer lives IN this hook —
// it moved down into vectrosApiTokenCache.ts's getVectrosApiToken itself
// (2026-08-26; see that module's SHARED_MINT_RETRY_DELAY_MS doc), because
// several independent useScopeGate call sites (nav items gating different
// actions) mount around the same moment, and a per-hook-instance retry
// couldn't stop each one from independently racing its OWN fresh mint the
// instant a predecessor's failure cleared the shared slot — measured live as
// 2-3 separate 403s for a single page load. These tests still exercise
// useScopeGate itself (via the REAL getVectrosApiToken/setPartnerApiTokenMinter
// seam, same pattern as vectrosApiTokenCache.test.ts, rather than mocking the
// module) — they're pinning that the hook still recovers correctly now that
// the retry mechanism sits one layer down, not asserting anything about
// where the retry lives.
// -----------------------------------------------------------------------------
describe('useScopeGate', () => {
  afterEach(() => {
    __resetVectrosApiTokenCacheForTest();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test('loading is true until the mint resolves, then exposes the resolved allowedActions/identity', async () => {
    setPartnerApiTokenMinter(async () => ({
      token: 'st_test',
      expiresAtMs: Date.now() + 900_000,
      resolvedScope: { allowedActions: ['records:r:case'], identity: { userId: 'usr_1' } },
    }));

    const { result } = renderHook(() => useScopeGate('tnt_test'));
    expect(result.current.loading).toBe(true);
    expect(result.current.allowedActions).toEqual([]);
    expect(result.current.identity).toEqual({});

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.allowedActions).toEqual(['records:r:case']);
    expect(result.current.identity).toEqual({ userId: 'usr_1' });
    expect(result.current.can('records:r:case')).toBe(true);
  });

  test('a minter that supplies no resolvedScope degrades to empty (not throw)', async () => {
    // A fork mid-migration, or an older backend response shape — the mint
    // itself still succeeds, but there's nothing to gate on.
    setPartnerApiTokenMinter(async () => ({ token: 'st_no_scope', expiresAtMs: Date.now() + 900_000 }));

    const { result } = renderHook(() => useScopeGate('tnt_test'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.allowedActions).toEqual([]);
    expect(result.current.identity).toEqual({});
    expect(result.current.can('records:r:case')).toBe(false);
  });

  test('a mint that fails once then succeeds on retry recovers — does not stick at empty', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let attempt = 0;
    setPartnerApiTokenMinter(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('transient mint failure');
      return {
        token: 'st_retry_ok',
        expiresAtMs: Date.now() + 10 * 60_000,
        resolvedScope: { allowedActions: ['records:r:case'], identity: {} },
      };
    });

    const { result } = renderHook(() => useScopeGate('tnt_test'));
    expect(result.current.loading).toBe(true);

    // Let the failed first attempt land, then advance past the retry delay.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(attempt).toBe(2);
    expect(result.current.can('records:r:case')).toBe(true);
    expect(result.current.allowedActions).toEqual(['records:r:case']);
  });

  test('a mint that fails on BOTH attempts degrades to empty (unchanged behavior)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let attempt = 0;
    setPartnerApiTokenMinter(async () => {
      attempt += 1;
      throw new Error('mint failure');
    });

    const { result } = renderHook(() => useScopeGate('tnt_test'));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(attempt).toBe(2);
    expect(result.current.allowedActions).toEqual([]);
    expect(result.current.can('records:r:case')).toBe(false);
  });

  test('a mint that succeeds on the first try never triggers a retry', async () => {
    let attempt = 0;
    setPartnerApiTokenMinter(async () => {
      attempt += 1;
      return {
        token: 'st_ok',
        expiresAtMs: Date.now() + 10 * 60_000,
        resolvedScope: { allowedActions: ['*'], identity: {} },
      };
    });

    const { result } = renderHook(() => useScopeGate('tnt_test'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(attempt).toBe(1);
    expect(result.current.can('anything:at:all')).toBe(true);
  });
});
