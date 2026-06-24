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
  decodeAllowedActions,
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
          { allowed_actions: ['admin:users'] },
          { allowed_actions: ['admin:keys', 'admin:users'] },
        ],
      },
    });
    expect(decodeAllowedActions(token).slice().sort()).toEqual([
      'admin:keys',
      'admin:users',
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
