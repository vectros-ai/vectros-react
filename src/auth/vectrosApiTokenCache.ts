// ---------------------------------------------------------------------------
// Partner-API token cache — module-local, in-memory, per (tenant, context).
//
// A reference app authenticates to the partner API (/v1/*) with a short-lived
// st_* bearer scoped to ONE tenant and ONE AppContext. This module caches those
// bearers and hands them to the axios request interceptor (non-React code that
// can't call `useAuth()`).
//
// **Why a (tenant, context) key.** The st_* token carries both a `tenant_id`
// and a `context_id` claim; data calls resolve to (tenant, context)
// from the token, unspoofably. admin-app (control plane) only varies the tenant
// — it passes no contextId, so its bearers key on tenant alone. app.vectros.ai
// (data plane) is single-tenant-at-a-time but multi-context: its context
// switcher mints a distinct bearer per contextId, so the cache holds one slot
// per (tenant, context) pair. Keeping the contextId optional makes the tenant-
// only callers (and their minters) work unchanged.
//
// **Provider-agnostic by injection.** The cache does NOT know how a bearer is
// minted — that's Vectros-specific (the developer API's scoped-token
// endpoint) and lives in the swappable auth provider. The host app injects a
// `PartnerApiTokenMinter` (wired to `CognitoAuthProvider.mintPartnerApiToken`);
// a fork wires its own. This keeps every `/developer/*` call inside the swap
// point so the reference apps stay forkable. Tests inject a mock minter directly.
//
// Refresh strategy: re-mint when the cached token is within REFRESH_BEFORE_MS of
// expiry. Cheap — with the minter's ~15-min TTL that's ~one mint per 14 minutes
// per (tenant, context) per browser session.
//
// Concurrent-mint coalescing (from the dev-portal hardening): multiple
// concurrent callers for the SAME (tenant, context) during the refresh window
// share a single in-flight Promise instead of each starting their own mint. The
// in-flight slot is cleared in a finally block so a failed mint can be retried.
//
// Clear-during-mint defense: a monotonically-incrementing
// `cacheGeneration` counter is captured when a mint starts and re-checked before
// the result is written. If a logout (or any path through
// `clearVectrosApiTokenCache`) bumps the generation while a mint is in flight,
// the result is THROWN AWAY rather than landing in the cache where the
// next-logged-in identity could read it. The counter is global (not per-slot) on
// purpose: one logout invalidates EVERY slot — the underlying Cognito session is
// shared. A context switch also calls clear(), so a stale-context bearer can
// never survive into the new context.
// ---------------------------------------------------------------------------

import type { TenantId } from './types';

/**
 * How long before expiry to proactively re-mint. With a ~900s mint TTL and
 * REFRESH_BEFORE_MS=60s, the cache hands out a valid token until ~840s after
 * mint, then mints a fresh one on the next call.
 */
const REFRESH_BEFORE_MS = 60_000;

/**
 * Mints a partner-API bearer scoped to `tenantId` and (optionally) `contextId`,
 * returning the raw token + its expiry (epoch ms). When `contextId` is omitted
 * the mint targets the caller's default/derived context (admin-app's behavior);
 * when supplied, the minted token's `context_id` claim is that context (the
 * data-plane context switcher). The Vectros reference impl is
 * `CognitoAuthProvider.mintPartnerApiToken`; a fork supplies its own. Injected
 * via {@link setPartnerApiTokenMinter}.
 */
export type PartnerApiTokenMinter = (
  tenantId: TenantId,
  contextId?: string,
) => Promise<{ readonly token: string; readonly expiresAtMs: number }>;

// ---- Module-local state (intentionally not reactive — the axios interceptor
//      reads + writes these on demand). Keyed by a composite (tenant, context)
//      string; see slotKey(). ----

const cachedTokens = new Map<string, string>();
/** Expiry as epoch-ms. Absent = no token. */
const cachedExpiriesMs = new Map<string, number>();
const inFlightMints = new Map<string, Promise<string>>();
let cacheGeneration = 0;
let minter: PartnerApiTokenMinter | null = null;

/**
 * Composite cache key for a (tenant, context) slot. The `|` separator can't
 * appear in a tenantId (`tnt_<uuid>`) or a validated contextId, so the join is
 * unambiguous. A missing contextId collapses to the tenant-only slot key
 * (`<tenantId>|`), which is what admin-app's tenant-only callers use.
 */
function slotKey(tenantId: TenantId, contextId?: string): string {
  return `${tenantId}|${contextId ?? ''}`;
}

/**
 * Register the function this cache uses to mint partner-API bearers. Call once
 * at app boot (after the auth adapter exists). Tests can call this with a mock —
 * there is no DI framework gluing it together.
 */
export function setPartnerApiTokenMinter(source: PartnerApiTokenMinter): void {
  minter = source;
}

/**
 * Get a partner-API st_* bearer for `(tenantId, contextId)`, minting a fresh one
 * if the cached value is absent or near expiry. `contextId` is optional — omit
 * it for the tenant-default context (admin-app), supply it for a specific
 * data-plane context (app.vectros.ai's switcher). Returns the raw token string —
 * callers (the axios interceptor) attach it as `Authorization: Bearer`.
 *
 * Concurrent callers for the SAME (tenant, context) share one in-flight mint
 * Promise; different slots mint independently. See the module comment for the
 * threat model behind the generation counter.
 *
 * @throws if the minter isn't registered or the mint fails.
 */
export function getVectrosApiToken(tenantId: TenantId, contextId?: string): Promise<string> {
  if (!tenantId) {
    return Promise.reject(new Error('getVectrosApiToken: a tenantId is required'));
  }

  const key = slotKey(tenantId, contextId);

  // Cache hit + still safely within the refresh-before-expiry window.
  const now = Date.now();
  const cachedToken = cachedTokens.get(key);
  if (cachedToken && (cachedExpiriesMs.get(key) ?? 0) > now + REFRESH_BEFORE_MS) {
    return Promise.resolve(cachedToken);
  }

  // Join an in-flight mint for this slot if one is already running. The
  // synchronous Map.set below (before the IIFE yields at its first await)
  // ensures a second caller in the same microtask sees the populated slot.
  const inFlight = inFlightMints.get(key);
  if (inFlight) {
    return inFlight;
  }

  // Capture the generation BEFORE the mint starts; if a clear bumps it while
  // the mint is in flight, the result is discarded (see module comment).
  const generationAtStart = cacheGeneration;

  // The IIFE captures `mintPromise` in its finally block to release the
  // in-flight slot only if it still references THIS mint. The definite-
  // assignment assertion + `let` (vs const) shape is required for that
  // self-reference; ESLint's prefer-const is suppressed on the assignment.
  let mintPromise!: Promise<string>;
  // eslint-disable-next-line prefer-const
  mintPromise = (async (): Promise<string> => {
    try {
      if (!minter) {
        throw new Error(
          'vectrosApiTokenCache: partner-API token minter not registered. ' +
            'Call setPartnerApiTokenMinter() at app boot before any partner-API call.',
        );
      }
      const { token, expiresAtMs } = await minter(tenantId, contextId);

      // If clearVectrosApiTokenCache fired while this mint was in flight, the
      // identity/context it was minted for is no longer active. Throw the result
      // away rather than caching it for the next-logged-in user or context.
      if (cacheGeneration !== generationAtStart) {
        throw new Error('Session cleared during partner-API token mint; discarding result.');
      }

      cachedTokens.set(key, token);
      cachedExpiriesMs.set(key, expiresAtMs);
      return token;
    } finally {
      // Release the in-flight slot — but ONLY if it still references THIS mint.
      // clearVectrosApiTokenCache clears the map, and a subsequent caller (now
      // in a fresh session/context) may have already started + registered a new mint.
      if (inFlightMints.get(key) === mintPromise) {
        inFlightMints.delete(key);
      }
    }
  })();
  inFlightMints.set(key, mintPromise);
  return mintPromise;
}

/**
 * Clear cached tokens for ALL slots, any in-flight mints, AND advance the cache
 * generation so any mint that started before this call discards its result
 * instead of writing it to the cache.
 *
 * The counter is global (not per-slot) on purpose: the underlying Cognito
 * session is shared, so a logout invalidates every slot. A tenant or context
 * switch also calls this, so a bearer for the previous tenant/context can never
 * survive the switch. Without the generation bump, "clear drops the partner-API
 * tokens" would be a lie for the window between a mint's start and finish — a
 * real cross-identity/context token leak. The mint's try block re-checks the
 * generation before writing.
 */
export function clearVectrosApiTokenCache(): void {
  cacheGeneration += 1;
  cachedTokens.clear();
  cachedExpiriesMs.clear();
  inFlightMints.clear();
}

/**
 * Test-only helper. Resets module state to a clean slate (including
 * un-registering the minter). Exported from the barrel for consuming apps' test
 * suites; runtime-safe (clear-only — it drops cached bearers and the minter, so
 * the worst a misuse can do is force a re-mint, never fabricate or widen a token).
 */
export function __resetVectrosApiTokenCacheForTest(): void {
  clearVectrosApiTokenCache();
  minter = null;
}
