// ---------------------------------------------------------------------------
// useScopeGate decode — direct unit coverage of decodeAllowedActions.
//
// This is the logic the whole client-side scope gate rests on: it reads the
// allowed actions out of the minted st_* token. The token carries them under
// `scope.scopes[]` (a list of clauses, each with an `allowed_actions` array).
// These tests use that exact shape so the decode can't silently drift from
// what the token actually contains.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, test } from 'vitest';

import {
  canPerform,
  decodeAllowedActions,
  decodeIdentity,
  __resetScopeGateDecodeCacheForTest,
} from './useScopeGate';

/** base64url-encode (no padding) — mirrors how a JWT segment is encoded. */
function b64url(s: string): string {
  return Buffer.from(s, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Build an `st_test_*`-shaped token whose payload is `claims`. */
function makeToken(claims: unknown): string {
  const header = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = b64url(JSON.stringify(claims));
  return `st_test_${header}.${payload}.sig`;
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

  test('works without the st_<env>_ prefix (bare JWT)', () => {
    const full = makeToken({ scope: { scopes: [{ allowed_actions: ['read'] }] } });
    const bare = full.replace(/^st_test_/, '');
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
