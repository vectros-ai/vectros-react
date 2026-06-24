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
   * Predicate: can the current session perform `action`? Wildcard `*` in
   * the allowed_actions list grants all actions. Specific entries match
   * literally — there is no resource:op pattern matching here (callers
   * pass the exact action string they want to check).
   */
  readonly can: (action: string) => boolean;
}

// Module-level decode cache keyed by raw token string. Avoids re-decoding
// the same token on every render across multiple useScopeGate consumers.
const decodedByToken = new Map<string, ReadonlyArray<string>>();

/**
 * Decode an st_*-shaped JWT and extract the union of allowed actions across
 * its scope clauses.
 *
 * Token shape: `st_(live|test)_<base64url-header>.<base64url-payload>.<base64url-sig>`.
 * (Some callers may pass the bare JWT without the `st_<env>_` prefix — we
 * handle both.)
 *
 * The relevant claim is `scope.scopes[]` — a list of clauses, each carrying an
 * `allowed_actions` string array. An owner's token is a single clause `["*"]`;
 * a scoped user's clauses carry their profile's specific actions. We union the
 * actions across every clause.
 *
 * **No signature verification.** The backend re-verifies on every request, and
 * client-side scope is a UX optimization only. Forged claims widen the visible
 * UI surface but don't unlock API calls.
 */
export function decodeAllowedActions(token: string): ReadonlyArray<string> {
  const cached = decodedByToken.get(token);
  if (cached) return cached;

  const empty: ReadonlyArray<string> = [];
  // Strip the st_<env>_ prefix if present.
  const stripped = token.replace(/^st_(live|test)_/, '');
  const parts = stripped.split('.');
  if (parts.length !== 3) {
    decodedByToken.set(token, empty);
    return empty;
  }
  try {
    // base64url → standard base64 + padding.
    const payloadSegment = parts[1] ?? '';
    const standard = payloadSegment.replace(/-/g, '+').replace(/_/g, '/');
    const padding = (4 - (standard.length % 4)) % 4;
    const padded = standard + '='.repeat(padding);
    const json = atob(padded);
    const claims = JSON.parse(json) as {
      scope?: { scopes?: ReadonlyArray<{ allowed_actions?: unknown }> };
    };
    const clauses = claims.scope?.scopes;
    if (!Array.isArray(clauses)) {
      decodedByToken.set(token, empty);
      return empty;
    }
    const actions = new Set<string>();
    for (const clause of clauses) {
      const list = clause?.allowed_actions;
      if (Array.isArray(list)) {
        for (const a of list) if (typeof a === 'string') actions.add(a);
      }
    }
    const result: ReadonlyArray<string> = [...actions];
    decodedByToken.set(token, result);
    return result;
  } catch {
    decodedByToken.set(token, empty);
    return empty;
  }
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
  const [actions, setActions] = useState<ReadonlyArray<string> | null>(null);

  useEffect(() => {
    // No active tenant yet (memberships still loading) — stay in the loading
    // state; the effect re-runs once a tenant resolves.
    if (tenantId == null) return;
    let cancelled = false;
    // Reset to loading on a tenant change so `can()` doesn't report the PRIOR
    // tenant's actions during the re-mint — otherwise a scoped user switching
    // tenants briefly gates routes on the old tenant's scope.
    setActions(null);
    getVectrosApiToken(tenantId)
      .then((token) => {
        if (!cancelled) setActions(decodeAllowedActions(token));
      })
      .catch(() => {
        // Mint failure (network, expired session, etc.) → treat as no
        // actions allowed. The UI hides everything until the user retries
        // or signs out + back in. Clean degraded mode.
        if (!cancelled) setActions([]);
      });
    return (): void => {
      cancelled = true;
    };
  }, [tenantId]);

  const allowed = actions ?? [];
  const can = (action: string): boolean => {
    if (allowed.includes('*')) return true;
    return allowed.includes(action);
  };

  return {
    loading: actions === null,
    allowedActions: allowed,
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
