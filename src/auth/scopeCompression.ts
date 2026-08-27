// ---------------------------------------------------------------------------
// scopeCompression — client-side inverse of the platform's scope-claim
// compression scheme: decompresses a minted `st_*` token's raw-DEFLATE,
// preset-dictionary-compressed `scope` claim back into its original JSON.
//
// **Why this exists.** The `scope` claim on an `st_*` token is DEFLATE-
// compressed (raw/nowrap, best-compression) against a fixed preset
// dictionary, then base64url-encoded, to keep large role/profile clause
// sets under a reasonable HTTP-header size budget. `useScopeGate.ts`
// decodes this claim client-side (a UX optimization — the backend
// re-verifies scope on every real request), so it needs the inverse
// transform.
//
// **The dictionary-drift risk this file carries.** The platform's own
// canonical decoder deliberately stays server-side only (a single-language
// implementation avoids two copies of the dictionary drifting apart) — this
// file is the one place that necessarily duplicates it, because a UI
// permission gate has to run in the browser. THIS DICTIONARY MUST STAY
// BYTE-IDENTICAL to the platform's own copy, and
// `scopeCompression.test.ts`'s fixture-decode test (pinned against a real,
// independently-verified token) is the tripwire that catches drift loudly
// instead of silently. A mismatch here reproduces exactly the failure mode
// this file exists to fix: every gated UI surface silently resolving to no
// permissions.
//
// ⚠️ **If the platform's own preset dictionary ever changes, `DICTIONARY`
// below MUST be updated to match, in the same change** — the two are read
// by different runtimes and nothing else keeps them in sync.
// ---------------------------------------------------------------------------

import { deflateRaw, inflateRaw } from 'pako';

/**
 * Byte-for-byte port of the platform's own preset dictionary (see the file
 * header above). Ordering matters — DEFLATE's preset-dictionary
 * back-references favor proximity to the end of the dictionary, so this
 * list must stay in the SAME order as the platform's copy, not just
 * contain the same entries.
 */
const DICTIONARY_STRING = [
  // Rarer / longer literals first.
  'member-lifecycle', 'forensic-read', 'context-directory-read', 'delegate-mint',
  'app-contexts', 'granted_capabilities', 'assumable', 'identity',
  '${{ under.self.scope.', '${{ under.self.userId }}', '${{ member.scope.',
  '${{ self.scope.', '${{ self.userId }}', '${{ any }}', ' }}',
  'partnerUserId', 'scope:group', 'scope:client', 'scope:org',
  'inference:', 'app-contexts:', 'search:', 'schemas:', 'folders:', 'entities:',
  'documents:', 'keys:', 'profiles:', 'users:', 'logs:r',
  // Common ops-letter combinations.
  ':crud', ':cru', ':crd', ':cr', ':ru', ':rd', ':c', ':r', ':u', ':d', ':s',
  'records:', 'data_scope', 'allowed_actions', 'scopes',
  // JSON structural fragments — highest frequency, placed last (closest to the data).
  'null', 'true', '"}', ']}', '},{', '":[', '":{', '":"', '","', '":', '{"',
].join('');

/** UTF-8 bytes of {@link DICTIONARY_STRING} — every entry above is ASCII, so this is a 1:1 encode. */
const DICTIONARY: Uint8Array = new TextEncoder().encode(DICTIONARY_STRING);

/** Decode an unpadded base64url string (the JWT/platform convention) to raw bytes. */
function base64urlToBytes(b64url: string): Uint8Array {
  const standard = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Encode raw bytes as an unpadded base64url string (the JWT/platform convention). */
function bytesToBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Mirrors the platform's own ceiling on decompressed output size — a
 * compressed blob's size is not on its own proof of its decompressed size
 * (highly-repetitive content compresses far better than typical scope
 * content). The server enforces this at mint/verify time; this is
 * defense-in-depth on the client read path, same value.
 */
const MAX_DECOMPRESSED_BYTES = 262_144;

/**
 * Inverse of the platform's own compression step: base64url-decodes
 * `compressed`, then raw-DEFLATE-inflates it against {@link DICTIONARY},
 * returning the original `scope` JSON string.
 *
 * Throws on malformed base64, corrupt/truncated DEFLATE data, a dictionary
 * mismatch (which manifests as a `pako` inflate error), or decompressed
 * output exceeding {@link MAX_DECOMPRESSED_BYTES} — callers should treat
 * any throw the same as an undecodable token (see `useScopeGate.ts`'s
 * `decodeScopeClaims`, which wraps this in a try/catch and falls back to
 * empty claims).
 */
export function decompressScopeClaim(compressed: string): string {
  const bytes = base64urlToBytes(compressed);
  const inflated = inflateRaw(bytes, { dictionary: DICTIONARY });
  if (inflated.length > MAX_DECOMPRESSED_BYTES) {
    throw new Error(
      `scope claim decompresses to more than ${MAX_DECOMPRESSED_BYTES} bytes — refusing to use it`,
    );
  }
  return new TextDecoder('utf-8').decode(inflated);
}

/**
 * Inverse of {@link decompressScopeClaim} — raw-DEFLATE-compresses `json`
 * against {@link DICTIONARY} (matching the platform's own compression
 * level) and base64url-encodes the result.
 *
 * Not used by any production code path — real tokens are only ever
 * compressed server-side. Exists so a consumer's own test suite can mint a
 * token whose `scope` claim is in the real wire shape (compressed) instead
 * of a plain object a real backend never sends — see the auth barrel's
 * export of this as `__compressScopeClaimForTest`.
 */
export function compressScopeClaim(json: string): string {
  const deflated = deflateRaw(new TextEncoder().encode(json), { dictionary: DICTIONARY, level: 9 });
  return bytesToBase64url(deflated);
}
