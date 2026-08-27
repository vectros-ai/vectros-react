// ---------------------------------------------------------------------------
// useScopeGate decode — direct unit coverage of decodeAllowedActions.
//
// This is the logic the whole client-side scope gate rests on: it reads the
// allowed actions out of the minted st_* token. The wire-carried `scope`
// claim is DEFLATE-compressed + base64url-encoded (see `scopeCompression.ts`);
// `makeToken` below compresses its `scope` payload with `pako`, matching what
// a real backend-minted token actually carries — building it as a plain
// object instead would test code the decoder no longer runs on the real
// path and let a decode-shape regression pass green.
// ---------------------------------------------------------------------------

import * as pako from 'pako';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

import {
  canPerform,
  decodeAllowedActions,
  decodeIdentity,
  useScopeGate,
  __resetScopeGateDecodeCacheForTest,
} from './useScopeGate';
import {
  __resetVectrosApiTokenCacheForTest,
  setPartnerApiTokenMinter,
} from './vectrosApiTokenCache';

/** base64url-encode (no padding) — mirrors how a JWT segment is encoded. */
function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// Same dictionary as scopeCompression.ts / the platform's own copy —
// duplicated here (rather than imported) so this test exercises the SAME
// byte sequence a consumer of the built package would, independent of
// scopeCompression.ts's own internal wiring.
const DICTIONARY = utf8(
  [
    'member-lifecycle', 'forensic-read', 'context-directory-read', 'delegate-mint',
    'app-contexts', 'granted_capabilities', 'assumable', 'identity',
    '${{ under.self.scope.', '${{ under.self.userId }}', '${{ member.scope.',
    '${{ self.scope.', '${{ self.userId }}', '${{ any }}', ' }}',
    'partnerUserId', 'scope:group', 'scope:client', 'scope:org',
    'inference:', 'app-contexts:', 'search:', 'schemas:', 'folders:', 'entities:',
    'documents:', 'keys:', 'profiles:', 'users:', 'logs:r',
    ':crud', ':cru', ':crd', ':cr', ':ru', ':rd', ':c', ':r', ':u', ':d', ':s',
    'records:', 'data_scope', 'allowed_actions', 'scopes',
    'null', 'true', '"}', ']}', '},{', '":[', '":{', '":"', '","', '":', '{"',
  ].join(''),
);

/** Compress `scope` the same way the platform's `ScopeCompression.compressToBase64` does. */
function compressScope(scope: unknown): string {
  const deflated = pako.deflateRaw(utf8(JSON.stringify(scope)), { dictionary: DICTIONARY, level: 9 });
  return b64url(deflated);
}

/**
 * Build an `st_*`-shaped token whose payload carries `scope` (compressed, matching
 * the real wire format) plus any other claims.
 */
function makeToken(claims: { scope?: unknown; [k: string]: unknown }): string {
  const { scope, ...rest } = claims;
  const payloadClaims = scope === undefined ? rest : { ...rest, scope: compressScope(scope) };
  const header = b64url(utf8(JSON.stringify({ alg: 'none', typ: 'JWT' })));
  const payload = b64url(utf8(JSON.stringify(payloadClaims)));
  return `st_${header}.${payload}.sig`;
}

beforeEach(() => {
  __resetScopeGateDecodeCacheForTest();
});

describe('decodeAllowedActions', () => {
  test("owner token (scope.scopes=[{allowed_actions:['*']}]) yields the wildcard", () => {
    const token = makeToken({ scope: { scopes: [{ allowed_actions: ['*'] }] } });
    expect(decodeAllowedActions(token)).toEqual(['*']);
  });

  test('scoped token yields exactly its clause actions', () => {
    const token = makeToken({
      scope: { scopes: [{ allowed_actions: ['read', 'logs:r'] }] },
    });
    expect(decodeAllowedActions(token)).toEqual(['read', 'logs:r']);
  });

  test('multiple clauses are unioned (and de-duplicated)', () => {
    const token = makeToken({
      scope: {
        scopes: [
          { allowed_actions: ['users:r'] },
          { allowed_actions: ['keys:r', 'users:r'] },
        ],
      },
    });
    expect(decodeAllowedActions(token).slice().sort()).toEqual([
      'keys:r',
      'users:r',
    ]);
  });

  test('works without the st_ prefix (bare JWT)', () => {
    const full = makeToken({ scope: { scopes: [{ allowed_actions: ['read'] }] } });
    const bare = full.replace(/^st_/, '');
    expect(decodeAllowedActions(bare)).toEqual(['read']);
  });

  test('a top-level allowed_actions claim is NOT read (no legacy flat shape)', () => {
    // The token only ever carries scope.scopes[]; a stray flat claim must not
    // be honored, so a drift back to the old flat decode is caught here.
    const token = makeToken({ allowed_actions: ['*'] });
    expect(decodeAllowedActions(token)).toEqual([]);
  });

  test('missing scope claim → empty', () => {
    expect(decodeAllowedActions(makeToken({ tenant_id: 't_1' }))).toEqual([]);
  });

  test('non-string entries are filtered out', () => {
    const token = makeToken({
      scope: { scopes: [{ allowed_actions: ['read', 42, null, 'logs:r'] }] },
    });
    expect(decodeAllowedActions(token)).toEqual(['read', 'logs:r']);
  });

  test('malformed tokens decode to empty (no throw)', () => {
    expect(decodeAllowedActions('not-a-jwt')).toEqual([]);
    expect(decodeAllowedActions('st_test_a.b')).toEqual([]); // too few segments
    expect(decodeAllowedActions('st_test_a.@@@.c')).toEqual([]); // bad base64/JSON
  });

  // A compressed `scope` claim that fails to decompress (corrupt data, or a
  // dictionary out of sync with the platform's) must degrade to empty
  // claims, not throw — the failure mode this file's decode exists to avoid.
  test('a corrupt compressed scope claim decodes to empty (no throw)', () => {
    const header = utf8(JSON.stringify({ alg: 'none', typ: 'JWT' }));
    const payload = utf8(JSON.stringify({ scope: 'not-valid-deflate-data!!!' }));
    const token = `st_${b64url(header)}.${b64url(payload)}.sig`;
    expect(decodeAllowedActions(token)).toEqual([]);
  });

  // A plain-object `scope` (the pre-compression wire shape) still decodes —
  // defensive only, see decodeScopeClaims's own doc for why.
  test('a legacy plain-object scope claim still decodes', () => {
    const header = utf8(JSON.stringify({ alg: 'none', typ: 'JWT' }));
    const payload = utf8(JSON.stringify({ scope: { scopes: [{ allowed_actions: ['*'] }] } }));
    const token = `st_${b64url(header)}.${b64url(payload)}.sig`;
    expect(decodeAllowedActions(token)).toEqual(['*']);
  });

  // Drift guard: a real compressed `scope` claim captured from a live-minted
  // st_* token (an OWNER account, short-lived token, no credentials). If
  // DICTIONARY in scopeCompression.ts ever drifts from the platform's own
  // copy, this fails loudly instead of silently.
  test('decodes a REAL staging-minted compressed scope claim (dictionary drift guard)', () => {
    const realCompressedScope =
      'q1aCKAOKVyuhGQBSq6UUq6OELY5Akrlo6QBoJko8g_QinAeyTgukDRHcSjog5wEdFlsLAA';
    const header = utf8(JSON.stringify({ alg: 'ES256', typ: 'JWT' }));
    const payload = utf8(JSON.stringify({ scope: realCompressedScope }));
    const token = `st_${b64url(header)}.${b64url(payload)}.sig`;
    expect(decodeAllowedActions(token)).toEqual(['*']);
  });
});

describe('decodeIdentity', () => {
  test('an OWNER token (no identity claim at all) yields an empty object', () => {
    const token = makeToken({ scope: { scopes: [{ allowed_actions: ['*'] }] } });
    expect(decodeIdentity(token)).toEqual({});
  });

  test('a sub-user token with scope:org + partnerUserId yields both, verbatim', () => {
    const token = makeToken({
      scope: {
        scopes: [{ allowed_actions: ['profiles:r'] }],
        identity: { partnerUserId: 'u_123', 'scope:org': 'org_a' },
      },
    });
    expect(decodeIdentity(token)).toEqual({
      partnerUserId: 'u_123',
      'scope:org': 'org_a',
    });
  });

  test('an explicit empty identity object also decodes to empty', () => {
    const token = makeToken({ scope: { scopes: [], identity: {} } });
    expect(decodeIdentity(token)).toEqual({});
  });

  test('non-string identity values are dropped, not coerced', () => {
    const token = makeToken({
      scope: { scopes: [], identity: { 'scope:org': 'org_a', 'scope:client': 42, junk: null } },
    });
    expect(decodeIdentity(token)).toEqual({ 'scope:org': 'org_a' });
  });

  test('a malformed identity shape (array, not object) decodes to empty (no throw)', () => {
    const token = makeToken({ scope: { scopes: [], identity: ['not', 'a', 'map'] } });
    expect(decodeIdentity(token)).toEqual({});
  });

  test('missing scope claim entirely → empty', () => {
    expect(decodeIdentity(makeToken({ tenant_id: 't_1' }))).toEqual({});
  });

  test('malformed tokens decode to empty (no throw)', () => {
    expect(decodeIdentity('not-a-jwt')).toEqual({});
    expect(decodeIdentity('st_test_a.b')).toEqual({});
    expect(decodeIdentity('st_test_a.@@@.c')).toEqual({});
  });

  test('decodeAllowedActions and decodeIdentity read the SAME token consistently (one decode pass, cached together)', () => {
    const token = makeToken({
      scope: {
        scopes: [{ allowed_actions: ['profiles:r', 'profiles:u'] }],
        identity: { 'scope:org': 'org_a' },
      },
    });
    expect(decodeAllowedActions(token)).toEqual(['profiles:r', 'profiles:u']);
    expect(decodeIdentity(token)).toEqual({ 'scope:org': 'org_a' });
  });
});

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
});

// -----------------------------------------------------------------------------
// useScopeGate's mint effect, observed through a failure+recovery cycle.
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
describe('useScopeGate — mint retry', () => {
  afterEach(() => {
    __resetVectrosApiTokenCacheForTest();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test('a mint that fails once then succeeds on retry recovers — does not stick at EMPTY_CLAIMS', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const token = makeToken({ scope: { scopes: [{ allowed_actions: ['records:r:case'] }] } });
    let attempt = 0;
    setPartnerApiTokenMinter(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('transient mint failure');
      return { token, expiresAtMs: Date.now() + 10 * 60_000 };
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

  test('a mint that fails on BOTH attempts degrades to EMPTY_CLAIMS (unchanged behavior)', async () => {
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
    const token = makeToken({ scope: { scopes: [{ allowed_actions: ['*'] }] } });
    let attempt = 0;
    setPartnerApiTokenMinter(async () => {
      attempt += 1;
      return { token, expiresAtMs: Date.now() + 10 * 60_000 };
    });

    const { result } = renderHook(() => useScopeGate('tnt_test'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(attempt).toBe(1);
    expect(result.current.can('anything:at:all')).toBe(true);
  });
});
