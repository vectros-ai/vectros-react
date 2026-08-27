// ---------------------------------------------------------------------------
// useScopeGate — data-driven UI gating from the session's token scope.
//
// Surfaces (nav items, action buttons, etc.) should render conditionally on
// whether the signed-in user actually has permission for them. This hook reads
// the allowed actions from the cached Vectros-API st_* token and exposes a
// `can(action)` predicate the UI uses to gate.
//
// **Where the scope comes from:** the scoped-token endpoint mints st_* tokens
// whose claims carry a `scope.scopes[]` list. Each clause has an
// `allowed_actions` string array; the hook unions them:
//   - owner    → a single clause `["*"]` (wildcard — grants everything)
//   - scoped   → clauses carrying the user's specific allowed actions
//
// We decode the token client-side (NO signature verification — that's the
// server's job at request time). This is safe because the worst-case
// adversarial scenario (token forgery) only fools the UI into showing
// extra surface; the backend will reject the actual API call.
//
// **Why JWT-decode rather than a `/developer/me` endpoint:** ships smaller.
// Doesn't add backend surface. A future backend adapter introduces
// `AuthProviderAdapter.getActiveTenant() / getMemberships()` which becomes
// the authoritative source; useScopeGate refactors then to read from
// memberships. For now the JWT-claim path is sufficient and the refactor
// is mechanical.
//
// **Tenant scope:** the hook reads the active tenant from `useCurrentTenant()`
// (the TenantSwitcher-controlled tenant) by default; an optional
// `tenantOverride: TenantId` checks a specific tenant instead.
//
// **File split rationale:** the `<ScopeGate>` component is in
// `./ScopeGate.tsx`. Hooks and components live in separate files per the
// admin-app convention (matches useAuth.ts + AuthProvider.tsx) — keeps
// react-refresh HMR clean and the auth barrel's re-exports unambiguous.
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react';

import { decompressScopeClaim } from './scopeCompression';
import { getVectrosApiToken } from './vectrosApiTokenCache';
import type { TenantId } from './types';
import { useCurrentTenant } from './useCurrentTenant';

/** Public shape returned by useScopeGate. */
export interface ScopeGateValue {
  /** True until the first token mint resolves. UIs typically render nothing during loading. */
  readonly loading: boolean;
  /** The decoded allowed_actions claim. Empty array if the token had no claim or decode failed. */
  readonly allowedActions: ReadonlyArray<string>;
  /**
   * The decoded `scope.identity` claim — the ownership dimensions (canonical
   * `scope:<ns>` keys) THIS session's own credential holds, if any. Empty
   * object for a credential with none (an OWNER session, which is never
   * bound to a specific identity — the claim is omitted from the token
   * entirely) or while loading. See {@link decodeIdentity} for the exact
   * semantics and why this answers a different question than `can(action)`.
   */
  readonly identity: Readonly<Record<string, string>>;
  /**
   * Predicate: can the current session perform `action`? Wildcard `*` grants
   * everything. For the compact `resource:ops` form (e.g. `'users:r'`,
   * `'users:cru'`), this unions ops across every UNQUALIFIED granted entry
   * for that resource — so a caller holding `users:c` + `users:r` + `users:u`
   * as three separate entries, or one combined `users:cru` entry, both
   * satisfy `can('users:ru')`. See {@link canPerform} for the exact rules
   * (in particular: why a qualified grant does NOT count toward an
   * unqualified ask, and why a malformed ops string falls back to an exact
   * string match rather than silently matching nothing).
   */
  readonly can: (action: string) => boolean;
}

/** The letters the platform's compact `resource:ops[:qualifier]` grammar recognizes. */
const CRUDS_LETTERS = 'cruds';

/** True when every character of `s` is a recognized ops letter, and `s` is non-empty. */
function isOpsString(s: string): boolean {
  return s.length > 0 && [...s].every((c) => CRUDS_LETTERS.includes(c));
}

/**
 * Ops-aware capability check: does `allowedActions` grant `action`?
 *
 * `action` may be:
 * - the wildcard `*` (not meaningful as an ask, but handled for symmetry — `*` is
 *   never true unless `allowedActions` itself carries wildcard, same as any other ask);
 * - the compact `resource:ops` form — e.g. `'users:r'`, `'users:cru'` — evaluated by
 *   OPS-UNION: every entry in `allowedActions` shaped exactly `resource:ops` (no
 *   qualifier) for the SAME resource contributes its ops letters to a running set;
 *   `action` is granted when every one of its own ops letters is in that set. This is
 *   what lets a caller's grant be spread across several entries (`users:c`, `users:r`,
 *   `users:u`) or combined into one (`users:cru`) and still be recognized identically —
 *   the shape the split-entries authoring path produces and the combined-entry path
 *   also produces are the same grant.
 * - the qualified `resource:ops:qualifier` form — e.g. `'records:r:case'` — evaluated by
 *   the SAME ops-union, narrowed to entries sharing BOTH the resource AND the exact
 *   qualifier. `'records:crud:case'` (one combined qualified entry, the shape a role's
 *   `allowedActions: [records:crud:case]` clause produces) satisfies an ask for
 *   `'records:r:case'` the same way `'users:cru'` satisfies `'users:r'` — this is NOT the
 *   widening the module doc's "qualified grant into unqualified ask" warning is about:
 *   the qualifier is identical on both sides, so nothing is generalized across resource
 *   instances. A qualified GRANT still never contributes to an ask with a DIFFERENT
 *   qualifier, or to an unqualified ask (that path is untouched); an UNQUALIFIED grant
 *   still never contributes to a qualified ask either (seen only via the exact-match
 *   fallback below, unchanged) — both keep the conservative, never-wider-than-what's-
 *   granted property the unqualified case already has.
 * - anything else (a bare custom verb, an ask/grant whose ops segment isn't a
 *   recognized ops string, or a length mismatch between ask and grant) — falls back to
 *   an EXACT string match against `allowedActions`. This is deliberate, not an
 *   oversight — the exact-match fallback is the conservative choice: never wider than
 *   what the caller can prove.
 */
export function canPerform(
  allowedActions: ReadonlyArray<string>,
  action: string,
): boolean {
  if (allowedActions.includes('*')) return true;

  const askedSegs = action.split(':');
  if (askedSegs.length === 2 || askedSegs.length === 3) {
    const [resource, askedOps, askedQualifier] = askedSegs;
    if (resource && isOpsString(askedOps ?? '')) {
      let grantedOps = '';
      for (const raw of allowedActions) {
        const segs = raw.split(':');
        if (segs.length !== askedSegs.length) continue; // shape mismatch — not unioned in
        const [grantedResource, grantedOpsStr, grantedQualifier] = segs;
        if (grantedResource !== resource) continue;
        if (askedSegs.length === 3 && grantedQualifier !== askedQualifier) continue;
        if (!isOpsString(grantedOpsStr ?? '')) continue;
        for (const c of grantedOpsStr ?? '') {
          if (!grantedOps.includes(c)) grantedOps += c;
        }
      }
      if (grantedOps) {
        return [...(askedOps ?? '')].every((c) => grantedOps.includes(c));
      }
      // No same-shape entry matched at all (e.g. only an unqualified grant exists
      // for a qualified ask, or vice versa) — fall through to exact-match below
      // rather than report denial from an empty union, so a literal-string grant
      // shaped exactly like the ask is still recognized.
    }
  }

  return allowedActions.includes(action);
}

/** What both public decode functions below extract from one token. */
interface DecodedScopeClaims {
  readonly allowedActions: ReadonlyArray<string>;
  readonly identity: Readonly<Record<string, string>>;
}

const EMPTY_ACTIONS: ReadonlyArray<string> = [];
const EMPTY_IDENTITY: Readonly<Record<string, string>> = {};
const EMPTY_CLAIMS: DecodedScopeClaims = { allowedActions: EMPTY_ACTIONS, identity: EMPTY_IDENTITY };

// Module-level decode cache keyed by raw token string. Avoids re-decoding
// (and re-parsing the same JWT payload twice, once per claim) on every render
// across multiple useScopeGate consumers.
const decodedByToken = new Map<string, DecodedScopeClaims>();

/**
 * Decode an st_*-shaped JWT's `scope` claim once, extracting both facets
 * `decodeAllowedActions`/`decodeIdentity` read. Not exported — those two
 * remain the public, independently-cacheable surface (mirrors how they were
 * two separate functions before `identity` existed, so existing callers of
 * `decodeAllowedActions` are unaffected).
 *
 * Token shape: `st_<base64url-header>.<base64url-payload>.<base64url-sig>` —
 * the platform mints tokens as `"st_" + jwt`, with no `live`/`test` env infix
 * despite what an older comment here claimed. (Some callers may pass the
 * bare JWT without the `st_` prefix — we handle both; the payload segment's
 * INDEX is unaffected either way, since the prefix has no `.` in it.)
 *
 * **The `scope` claim itself is DEFLATE-compressed + base64url-encoded** —
 * see `scopeCompression.ts`'s file header for the full story (including the
 * dictionary-drift risk this decode carries) and for the decompression this
 * is the inverse of. Decompression failure (corrupt data, or a dictionary
 * that's drifted out of sync with the platform's) is handled the same as
 * any other malformed-token case below: empty claims, no throw.
 *
 * **No signature verification.** The backend re-verifies on every request, and
 * client-side scope is a UX optimization only. Forged claims widen the visible
 * UI surface but don't unlock API calls.
 */
function decodeScopeClaims(token: string): DecodedScopeClaims {
  const cached = decodedByToken.get(token);
  if (cached) return cached;

  // Strip the st_ prefix if present.
  const stripped = token.replace(/^st_/, '');
  const parts = stripped.split('.');
  if (parts.length !== 3) {
    decodedByToken.set(token, EMPTY_CLAIMS);
    return EMPTY_CLAIMS;
  }
  try {
    // base64url → standard base64 + padding.
    const payloadSegment = parts[1] ?? '';
    const standard = payloadSegment.replace(/-/g, '+').replace(/_/g, '/');
    const padding = (4 - (standard.length % 4)) % 4;
    const padded = standard + '='.repeat(padding);
    const json = atob(padded);
    const claims = JSON.parse(json) as { scope?: unknown };

    // `scope` is a compressed opaque string on every real token — decompress
    // it back into the `{scopes, identity}` shape below. A plain object is
    // also accepted (test fixtures, and a defensive
    // hedge against any future rollback of the compression change) so this
    // decode doesn't itself become a second thing to keep in lockstep with a
    // wire-format change.
    let scopeClaims: { scopes?: ReadonlyArray<{ allowed_actions?: unknown }>; identity?: unknown } | undefined;
    if (typeof claims.scope === 'string') {
      scopeClaims = JSON.parse(decompressScopeClaim(claims.scope)) as typeof scopeClaims;
    } else if (claims.scope != null && typeof claims.scope === 'object') {
      scopeClaims = claims.scope as typeof scopeClaims;
    }

    const clauses = scopeClaims?.scopes;
    let allowedActions = EMPTY_ACTIONS;
    if (Array.isArray(clauses)) {
      const actions = new Set<string>();
      for (const clause of clauses) {
        const list = clause?.allowed_actions;
        if (Array.isArray(list)) {
          for (const a of list) if (typeof a === 'string') actions.add(a);
        }
      }
      allowedActions = [...actions];
    }

    // `scope.identity` — the ownership dimensions THIS session's own
    // credential holds (canonical `scope:<ns>` keys, e.g. `scope:org`; plus
    // `partnerUserId` when the token is bound to a specific user). Omitted
    // entirely on the wire for a credential with none (an OWNER session) —
    // never present as an empty object, but we treat both the same way here.
    const rawIdentity = scopeClaims?.identity;
    let identity = EMPTY_IDENTITY;
    if (rawIdentity != null && typeof rawIdentity === 'object' && !Array.isArray(rawIdentity)) {
      const result: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawIdentity as Record<string, unknown>)) {
        if (typeof v === 'string') result[k] = v;
      }
      identity = result;
    }

    const decoded: DecodedScopeClaims = { allowedActions, identity };
    decodedByToken.set(token, decoded);
    return decoded;
  } catch {
    decodedByToken.set(token, EMPTY_CLAIMS);
    return EMPTY_CLAIMS;
  }
}

/**
 * Decode an st_*-shaped JWT and extract the union of allowed actions across
 * its scope clauses (`scope.scopes[].allowed_actions`). An owner's token is a
 * single clause `["*"]`; a scoped user's clauses carry their profile's
 * specific actions. We union the actions across every clause.
 *
 * **No signature verification** — see {@link decodeIdentity}'s doc for why
 * that's safe here.
 */
export function decodeAllowedActions(token: string): ReadonlyArray<string> {
  return decodeScopeClaims(token).allowedActions;
}

/**
 * Decode an st_*-shaped JWT and extract the `scope.identity` claim — the
 * ownership dimensions (canonical `scope:<ns>` keys) THIS session's own
 * credential holds, if any. Empty object for a credential with none (an
 * OWNER session is never bound to a specific identity; the claim is omitted
 * from the token entirely in that case).
 *
 * This is NOT the same question as `can(action)` — holding an identity value
 * doesn't grant an action, and holding an action doesn't confer an identity.
 * It answers a narrower question some surfaces need: "does this session's own
 * credential hold an identity value it could legitimately confer onto
 * something else?" (see the platform's identity-conferral rule — a caller may
 * grant exactly the identity value it itself holds, never an arbitrary one).
 *
 * **No signature verification.** The backend re-verifies on every request,
 * and reading this client-side is a UX optimization only, same as
 * `decodeAllowedActions` — forged claims could only make the UI wrongly show
 * an affordance that then fails server-side, never grant anything.
 */
export function decodeIdentity(token: string): Readonly<Record<string, string>> {
  return decodeScopeClaims(token).identity;
}

/**
 * Read the current session's allowed actions and expose a can-do predicate.
 *
 * Loading state is true until the first token mint resolves. Consumers
 * typically render nothing (or a skeleton) during loading. For nav items
 * specifically, hiding-during-load is preferred over a flash-of-content.
 *
 * @param tenantOverride force a specific tenant scope to read. Omit to read
 *                       from `useCurrentTenant()` (the TenantSwitcher-controlled
 *                       active tenant). Override is rare — typically only to
 *                       check permissions against a DIFFERENT tenant than the
 *                       active one.
 */
export function useScopeGate(tenantOverride?: TenantId): ScopeGateValue {
  const { tenant } = useCurrentTenant();
  const tenantId = tenantOverride ?? tenant;
  const [decoded, setDecoded] = useState<DecodedScopeClaims | null>(null);

  useEffect(() => {
    // No active tenant yet (memberships still loading) — stay in the loading
    // state; the effect re-runs once a tenant resolves.
    if (tenantId == null) return;
    let cancelled = false;
    // Reset to loading on a tenant change so `can()`/`identity` don't report
    // the PRIOR tenant's claims during the re-mint — otherwise a scoped user
    // switching tenants briefly gates routes on the old tenant's scope.
    setDecoded(null);

    // The retry-on-a-failed-mint logic used to live here, per hook instance.
    // Moved DOWN into vectrosApiTokenCache.ts's getVectrosApiToken itself
    // (2026-08-26) — several independent consumers (this hook, on nav items
    // for different actions) each call getVectrosApiToken around the same
    // moment, and a per-instance retry here couldn't stop each one from
    // independently racing its OWN fresh mint the instant its predecessor's
    // failure cleared the shared slot. Retrying inside the cache's own
    // in-flight promise means every consumer arriving during the retry
    // window joins the SAME attempt instead of starting an independent one.
    // See that module's SHARED_MINT_RETRY_DELAY_MS doc for the full story.
    getVectrosApiToken(tenantId)
      .then((token) => {
        if (!cancelled) setDecoded(decodeScopeClaims(token));
      })
      .catch(() => {
        // Mint failure (network, expired session, etc.) → treat as no
        // actions/identity. The UI hides everything until the user retries
        // or signs out + back in. Clean degraded mode.
        if (!cancelled) setDecoded(EMPTY_CLAIMS);
      });
    return (): void => {
      cancelled = true;
    };
  }, [tenantId]);

  const allowed = decoded?.allowedActions ?? EMPTY_ACTIONS;
  const identity = decoded?.identity ?? EMPTY_IDENTITY;
  const can = (action: string): boolean => canPerform(allowed, action);

  return {
    loading: decoded === null,
    allowedActions: allowed,
    identity,
    can,
  };
}

/**
 * Test-only helper. Clears the module-level decode cache so each test starts
 * from a clean slate. Exported from the barrel for consuming apps' test suites;
 * runtime-safe (clear-only — it cannot affect scope decisions, which the backend
 * re-verifies on every request).
 */
export function __resetScopeGateDecodeCacheForTest(): void {
  decodedByToken.clear();
}
