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
//
// **The identity-override axis (`POST /v1/auth/token/assume`).** A (tenant,
// context) bearer's `identity.<namespace>` (e.g. `scope:org`) picks ONE default
// value — for a caller admitted to more than one (a multi-org practitioner
// switching which org a new record is placed under), a DIFFERENT bearer is
// needed per active value. Rather than a second minting path, the cache layers
// on top of the existing (tenant, context) slot: an override request first
// resolves the BASE bearer for that slot (via the ordinary minter, sharing its
// cache entry with every other caller of that slot), then exchanges it for an
// assumed bearer via the injected `PartnerApiTokenAssumer` — the SDK client
// method for `POST /v1/auth/token/assume`. The assumed bearer gets its OWN
// cache slot, keyed by (tenant, context, namespace, value), so switching back
// and forth between two orgs re-uses both cached bearers instead of
// re-exchanging every time. Same refresh/coalescing/generation-counter
// machinery as the base path — see `getVectrosApiToken`'s override branch.
//
// Named `*Override`/`*Assumer` rather than `*Switch(er)` deliberately — an
// earlier draft of this axis was built against a since-deleted `/switch`
// endpoint design (a broader entitlement check found unsound before it
// shipped). This module was renamed to match the endpoint that actually
// exists, `POST /v1/auth/token/assume`, entitlement checked against a single
// requested value at a time, never inferred from broader read/write reach.
// ---------------------------------------------------------------------------

import type { TenantId } from './types';

/**
 * Which single-value identity namespace to activate on the returned bearer, and
 * which value — the `POST /v1/auth/token/assume` request shape, e.g.
 * `{ namespace: 'scope:org', value: 'orgB' }`. Optional third argument to
 * {@link getVectrosApiToken}; omit for the base (tenant, context) bearer.
 */
export interface VectrosIdentityOverride {
  /** Canonical `scope:<namespace>` form, matching the API's own grammar. */
  readonly namespace: string;
  readonly value: string;
}

/**
 * How long before expiry to proactively re-mint. With a ~900s mint TTL and
 * REFRESH_BEFORE_MS=60s, the cache hands out a valid token until ~840s after
 * mint, then mints a fresh one on the next call.
 */
const REFRESH_BEFORE_MS = 60_000;

/**
 * How long to wait before ONE shared retry of a failed mint, still within the
 * SAME in-flight promise (see the retry block in {@link getVectrosApiToken}).
 *
 * Live-tested 2026-08-26: a token exchange for an identity that was JUST
 * activated (e.g. the moment `RequireAuth` renders the authenticated shell,
 * right after a successful invite-accept) can still 403 on its very next
 * exchange — a real, observed backend-side race/staleness right after
 * activation (filed separately, platform-side). Several DIFFERENT UI
 * consumers (nav items' own `ScopeGate`s, etc.) each call `getVectrosApiToken`
 * independently around the same moment; without this, EACH one raced its own
 * fresh mint, so one failure didn't stop three more identical failures a
 * beat later — measured live as 2-3 separate 403s for a SINGLE page load.
 * Keeping the retry INSIDE this same in-flight promise (rather than, say,
 * each caller retrying on its own after catching a rejection) means any
 * caller arriving during the delay/retry window JOINS this one attempt
 * instead of starting an independent one of its own — collapsing what were
 * several racing failures into one shared recovery.
 */
const SHARED_MINT_RETRY_DELAY_MS = 1500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

/**
 * Exchanges an already-minted partner-API bearer for one with a single
 * identity namespace assumed to a different admitted value — the SDK client
 * method for `POST /v1/auth/token/assume`. `bearer` is the BASE (tenant,
 * context) token this cache already holds; the Vectros reference impl calls
 * the endpoint with that bearer as `Authorization`. A fork supplies its own.
 * Injected via {@link setPartnerApiTokenAssumer}.
 */
export type PartnerApiTokenAssumer = (
  bearer: string,
  override: VectrosIdentityOverride,
) => Promise<{ readonly token: string; readonly expiresAtMs: number }>;

// ---- Module-local state (intentionally not reactive — the axios interceptor
//      reads + writes these on demand). Keyed by a composite (tenant, context[,
//      namespace, value]) string; see slotKey(). ----

const cachedTokens = new Map<string, string>();
/** Expiry as epoch-ms. Absent = no token. */
const cachedExpiriesMs = new Map<string, number>();
const inFlightMints = new Map<string, Promise<string>>();
let cacheGeneration = 0;
let minter: PartnerApiTokenMinter | null = null;
let assumer: PartnerApiTokenAssumer | null = null;

/**
 * Composite cache key for a (tenant, context[, namespace, value]) slot. The
 * `|` separator can't appear in a tenantId (`tnt_<uuid>`), a validated
 * contextId, or a validated namespace/value (the API's identifier grammar), so
 * the join is unambiguous. A missing contextId collapses to the tenant-only
 * slot key (`<tenantId>|`), which is what admin-app's tenant-only callers use;
 * a missing override collapses to the plain (tenant, context) slot, unchanged
 * from before the override axis existed.
 */
function slotKey(tenantId: TenantId, contextId?: string, override?: VectrosIdentityOverride): string {
  const base = `${tenantId}|${contextId ?? ''}`;
  return override ? `${base}|${override.namespace}|${override.value}` : base;
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
 * Register the function this cache uses to exchange a bearer for an
 * identity-assumed one (`POST /v1/auth/token/assume`). Only required by apps
 * that actually pass an {@link VectrosIdentityOverride} to
 * {@link getVectrosApiToken} — omit it entirely for a tenant/context-only app
 * (admin-app's shape) and the override branch is simply never reached.
 */
export function setPartnerApiTokenAssumer(source: PartnerApiTokenAssumer): void {
  assumer = source;
}

/**
 * Get a partner-API st_* bearer for `(tenantId, contextId)`, minting a fresh one
 * if the cached value is absent or near expiry. `contextId` is optional — omit
 * it for the tenant-default context (admin-app), supply it for a specific
 * data-plane context (app.vectros.ai's switcher). Returns the raw token string —
 * callers (the axios interceptor) attach it as `Authorization: Bearer`.
 *
 * `identityOverride` is optional — omit it for the plain (tenant, context)
 * bearer (unchanged from before the override axis existed). Supply
 * `{ namespace, value }` to instead get a bearer with that namespace assumed
 * to that value (`POST /v1/auth/token/assume`, for a multi-org practitioner
 * choosing which org to act as) — this slot is cached SEPARATELY from the base
 * bearer (see the module comment), and resolving it first resolves the base
 * bearer via the ordinary minter, sharing that slot's own cache/coalescing.
 *
 * Concurrent callers for the SAME slot share one in-flight mint Promise;
 * different slots mint independently. See the module comment for the threat
 * model behind the generation counter.
 *
 * @throws if the minter (or, for an override, the assumer) isn't registered,
 *         or the mint/assume fails.
 */
export function getVectrosApiToken(
  tenantId: TenantId,
  contextId?: string,
  identityOverride?: VectrosIdentityOverride,
): Promise<string> {
  if (!tenantId) {
    return Promise.reject(new Error('getVectrosApiToken: a tenantId is required'));
  }

  const key = slotKey(tenantId, contextId, identityOverride);

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

  /**
   * How to get a fresh token for THIS slot — the one thing that differs
   * between the base path and the override path. Not invoked until the IIFE
   * below actually starts (still synchronous up to here, so the in-flight
   * Map.set above happens before any await, same as before this branch existed).
   */
  const fetchFresh = (): Promise<{ readonly token: string; readonly expiresAtMs: number }> => {
    if (!identityOverride) {
      if (!minter) {
        throw new Error(
          'vectrosApiTokenCache: partner-API token minter not registered. ' +
            'Call setPartnerApiTokenMinter() at app boot before any partner-API call.',
        );
      }
      return minter(tenantId, contextId);
    }
    if (!assumer) {
      throw new Error(
        'vectrosApiTokenCache: partner-API token assumer not registered. ' +
          'Call setPartnerApiTokenAssumer() at app boot before requesting an identity override.',
      );
    }
    // Resolve the BASE (tenant, context) bearer first — a DIFFERENT cache slot
    // (no override), so this shares its cache entry and in-flight coalescing
    // with every other caller of the base token rather than minting a second one.
    return getVectrosApiToken(tenantId, contextId).then((baseBearer) => assumer!(baseBearer, identityOverride));
  };

  // The IIFE captures `mintPromise` in its finally block to release the
  // in-flight slot only if it still references THIS mint. The definite-
  // assignment assertion + `let` (vs const) shape is required for that
  // self-reference; ESLint's prefer-const is suppressed on the assignment.
  let mintPromise!: Promise<string>;
  // eslint-disable-next-line prefer-const
  mintPromise = (async (): Promise<string> => {
    // Unconditional yield BEFORE any work — load-bearing, not decorative.
    // Without it, a mint that rejects with NO other `await` before the throw
    // (the "minter not registered" case is the one that actually happens: a
    // gated component can render — and call this — before app boot's
    // setPartnerApiTokenMinter() has run) completes its entire try/finally
    // SYNCHRONOUSLY, within the same call that's still constructing this
    // IIFE — i.e. BEFORE the `mintPromise = ...` assignment below and the
    // `inFlightMints.set(key, mintPromise)` line after it have executed. The
    // finally's self-reference guard (`inFlightMints.get(key) === mintPromise`)
    // then compares against a not-yet-assigned `mintPromise`, always reads
    // false, and never deletes — so `inFlightMints.set` afterwards plants an
    // ALREADY-REJECTED, ALREADY-FINALLY-RAN promise that nothing will ever
    // clean up again. Every later caller for this slot joins that same dead
    // promise forever, even after a minter is registered. Yielding first
    // guarantees the assignment + the map-set below always complete before
    // this function's body can possibly reach its own finally.
    await Promise.resolve();
    try {
      let result: { readonly token: string; readonly expiresAtMs: number };
      try {
        result = await fetchFresh();
      } catch (firstErr) {
        // Don't retry a "not configured yet" failure — a missing minter/
        // assumer registration doesn't clear itself on a ~1.5s timescale;
        // what actually recovers it is the NEXT independent call, once app
        // boot has caught up (see the "does NOT permanently poison the
        // slot" test). Retrying here would just cost time for no benefit.
        const stillUnconfigured = identityOverride ? !assumer : !minter;
        if (stillUnconfigured || cacheGeneration !== generationAtStart) {
          throw firstErr;
        }
        await delay(SHARED_MINT_RETRY_DELAY_MS);
        if (cacheGeneration !== generationAtStart) {
          throw firstErr;
        }
        result = await fetchFresh();
      }
      const { token, expiresAtMs } = result;

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
  assumer = null;
}
