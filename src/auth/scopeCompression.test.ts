// ---------------------------------------------------------------------------
// scopeCompression — round-trip + real-fixture coverage.
//
// useScopeGate.test.ts also exercises this indirectly (through decodeAllowedActions
// with tokens compressed via the same dictionary); these tests pin the module's
// OWN contract directly, including round-trip vectors mirroring the platform's
// own compression tests, so a drift in either direction (this module vs the
// platform's own copy) is caught here first.
// ---------------------------------------------------------------------------

import * as pako from 'pako';
import { describe, expect, test } from 'vitest';

import { compressScopeClaim, decompressScopeClaim } from './scopeCompression';

// Same dictionary bytes as scopeCompression.ts (duplicated deliberately, same
// rationale as useScopeGate.test.ts's own copy — exercise what a consumer of
// the built module sees, not scopeCompression.ts's internals).
function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
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

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function compress(json: string): string {
  return b64url(pako.deflateRaw(utf8(json), { dictionary: DICTIONARY, level: 9 }));
}

describe('decompressScopeClaim', () => {
  // Mirrors ScopeCompressionTest.roundTrip_simpleClause.
  test('round-trips a simple clause', () => {
    const json = '{"scopes":[{"allowed_actions":["records:r"]}]}';
    expect(decompressScopeClaim(compress(json))).toEqual(json);
  });

  // Mirrors ScopeCompressionTest.roundTrip_emptyString.
  test('round-trips an empty string', () => {
    expect(decompressScopeClaim(compress(''))).toEqual('');
  });

  // Mirrors ScopeCompressionTest.roundTrip_unicodeContent.
  test('round-trips multi-byte UTF-8 content', () => {
    const json =
      '{"scopes":[{"allowed_actions":["records:r"],' +
      '"data_scope":{"scope:org":["orgA-日本語-🎉"]}}]}';
    expect(decompressScopeClaim(compress(json))).toEqual(json);
  });

  // A real compressed scope claim captured from a live-minted st_* token
  // (an OWNER account, short-lived token, no credentials). The expected
  // plaintext below was independently cross-checked against the platform's
  // own canonical decoder, confirming this module's output byte-for-byte
  // matches the platform's own decode — the dictionary-drift tripwire this
  // module exists to guard against.
  test('decodes a REAL staging-minted compressed scope claim', () => {
    const realCompressedScope =
      'q1aCKAOKVyuhGQBSq6UUq6OELY5Akrlo6QBoJko8g_QinAeyTgukDRHcSjog5wEdFlsLAA';
    expect(JSON.parse(decompressScopeClaim(realCompressedScope))).toEqual({
      scopes: [
        {
          allowed_actions: ['*'],
          granted_capabilities: ['member-lifecycle', 'delegate-mint'],
          data_scope: { '*': ['${{ any }}', null] },
        },
      ],
    });
  });

  test('throws on malformed base64', () => {
    expect(() => decompressScopeClaim('not-valid-base64!!!@@@')).toThrow();
  });

  test('throws on truncated compressed data', () => {
    const compressed = compress('{"scopes":[{"allowed_actions":["records:r"]}]}');
    const truncated = compressed.slice(0, Math.max(1, Math.floor(compressed.length / 2)));
    expect(() => decompressScopeClaim(truncated)).toThrow();
  });

  // Mirrors ScopeCompressionTest.decompressFromBase64_overLimit_rejectedRatherThanFullyAllocated —
  // a compressed blob's size is not on its own proof of its decompressed size.
  test('throws when decompressed output exceeds the size ceiling', () => {
    const oversized = 'org_engineering,'.repeat(20_000); // well over 262_144 bytes raw
    const compressed = compress(oversized);
    // Premise check: highly repetitive content compresses to something tiny.
    expect(compressed.length).toBeLessThan(1000);
    expect(() => decompressScopeClaim(compressed)).toThrow();
  });
});

describe('compressScopeClaim', () => {
  // Exercises the EXPORTED compress function directly (not the test file's own
  // local `compress` helper) round-tripped through the exported decompress —
  // proves the shipped compress/decompress pair agree with each other, not just
  // that each independently agrees with a locally-reimplemented dictionary.
  test('round-trips through decompressScopeClaim', () => {
    const json = '{"scopes":[{"allowed_actions":["users:cru"]}],"identity":{"scope:org":"org_a"}}';
    expect(decompressScopeClaim(compressScopeClaim(json))).toEqual(json);
  });

  test('produces unpadded base64url (no +, /, or =)', () => {
    const out = compressScopeClaim('{"scopes":[{"allowed_actions":["*"]}]}');
    expect(out).not.toMatch(/[+/=]/);
  });

  // A single small clause is exactly the case a raw (undictionaried) compressor
  // loses on — proves the preset dictionary is actually engaged here too, not
  // just present in source.
  test('a single realistic clause compresses smaller than its raw JSON', () => {
    const json =
      '{"scopes":[{"allowed_actions":["records:cru:case","records:cru:case_note"],' +
      '"data_scope":{"scope:org":["${{ member.scope.org }}"]}}]}';
    expect(compressScopeClaim(json).length).toBeLessThan(json.length);
  });
});
