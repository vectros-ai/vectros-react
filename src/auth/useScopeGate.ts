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
 * - anything else (a bare custom verb, a 3-segment qualified form like
 *   `'documents:r:foo'`, or a malformed ops string) — falls back to an EXACT string
 *   match against `allowedActions`. This is deliberate, not an oversight: a QUALIFIED
 *   grant narrows to a specific resource instance, so it must NOT be unioned into an
 *   UNQUALIFIED ask — doing so would let a caller scoped to one record type or
 *   namespace appear to hold the resource generally. Whether a qualifier is actually
 *   meaningful for a given resource+op is a platform authorization-grammar question
 *   (`TokenScope`'s qualifiable-resource / sensitive-reveal axes) this client-side
 *   predicate does not attempt to replicate — the exact-match fallback is the
 *   conservative choice: never wider than what the caller can prove.
 */
export function canPerform(
  allowedActions: ReadonlyArray<string>,
  action: string,
): boolean {
  if (allowedActions.includes('*')) return true;

  const askedSegs = action.split(':');
  if (askedSegs.length === 2) {
    const [resource, askedOps] = askedSegs;
    if (resource && isOpsString(askedOps ?? '')) {
      let grantedOps = '';
      for (const raw of allowedActions) {
        const segs = raw.split(':');
        if (segs.length !== 2) continue; // qualified (or malformed) — not unioned in
        const [grantedResource, grantedOpsStr] = segs;
        if (grantedResource !== resource) continue;
        if (!isOpsString(grantedOpsStr ?? '')) continue;
        for (const c of grantedOpsStr ?? '') {
          if (!grantedOps.includes(c)) grantedOps += c;
        }
      }
      return [...(askedOps ?? '')].every((c) => grantedOps.includes(c));
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
 * Token shape: `st_(live|test)_<base64url-header>.<base64url-payload>.<base64url-sig>`.
 * (Some callers may pass the bare JWT without the `st_<env>_` prefix — we
 * handle both.)
 *
 * **No signature verification.** The backend re-verifies on every request, and
 * client-side scope is a UX optimization only. Forged claims widen the visible
 * UI surface but don't unlock API calls.
 */
function decodeScopeClaims(token: string): DecodedScopeClaims {
  const cached = decodedByToken.get(token);
  if (cached) return cached;

  // Strip the st_<env>_ prefix if present.
  const stripped = token.replace(/^st_(live|test)_/, '');
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
    const claims = JSON.parse(json) as {
      scope?: {
        scopes?: ReadonlyArray<{ allowed_actions?: unknown }>;
        identity?: unknown;
      };
    };

    const clauses = claims.scope?.scopes;
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
    const rawIdentity = claims.scope?.identity;
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
