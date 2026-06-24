// ---------------------------------------------------------------------------
// useCurrentTenant — current-tenant state for the admin-app.
//
// The env-string shim ([Live, Test] hardcoded) is RETIRED.
// Memberships now come from `authProvider.getMemberships()` (the real
// /developer/memberships read-side) and the active tenant from the
// `active_tenant` JWT claim (`authProvider.getActiveTenant()`), surfaced here
// via CurrentTenantProvider. A tenant is identified by its real `TenantId`
// (UUID); the live/test distinction lives on each membership's `tenantKind`.
//
// The TenantSwitcher UI + this hook's role are unchanged in spirit — only the
// data source + the identifier type (TenantEnv → TenantId) changed.
//
// **Switching** is now a server-side operation: `setTenant(tenantId)` persists
// the choice (UserSessionPrefsDB) + refreshes the JWT via
// `authProvider.setActiveTenant()`, drops the partner-API token cache, and
// refetches tenant-scoped queries. It's therefore async.
//
// **No-provider fallback:** for test ergonomics + render helpers that don't
// wrap CurrentTenantProvider, the hook returns inert defaults (no active
// tenant, empty memberships, no-op setTenant). Pages must treat `tenant ===
// null` as "not ready" and gate their data reads on it.
//
// **File-split convention:** Provider component lives in
// `./CurrentTenantProvider.tsx` (matches useAuth.ts + AuthProvider.tsx).
// ---------------------------------------------------------------------------

import { createContext, useContext } from 'react';

import type { TenantId, TenantMembership } from './types';

/** Re-export so consumers can `import { TenantMembership } from '../auth/...'`. */
export type { TenantMembership } from './types';

/** The context value exposed to consumers. */
export interface CurrentTenantContextValue {
  /** The active tenant's id, or null while memberships load / when none exist. */
  readonly tenant: TenantId | null;
  /**
   * Switch the active tenant: persists server-side + refreshes the JWT, drops
   * the partner-API token cache, and refetches tenant-scoped data. Async.
   */
  readonly setTenant: (tenantId: TenantId) => Promise<void>;
  /** All tenants the user belongs to (empty while loading / when none). */
  readonly memberships: ReadonlyArray<TenantMembership>;
  /** True during the initial memberships + active-tenant load. */
  readonly loading: boolean;
  /** The membership matching `tenant` (kind/name/role/partnerId), or null. */
  readonly activeMembership: TenantMembership | null;
}

export const CurrentTenantContext = createContext<CurrentTenantContextValue | null>(null);

/**
 * Read the current tenant + memberships + setter.
 *
 * **No-provider fallback:** returns inert defaults (no active tenant, empty
 * memberships, no-op setTenant) when called outside a provider. Consumers must
 * gate tenant-scoped reads on `tenant !== null`.
 */
export function useCurrentTenant(): CurrentTenantContextValue {
  const ctx = useContext(CurrentTenantContext);
  if (ctx) return ctx;
  return {
    tenant: null,
    setTenant: async () => undefined,
    memberships: [],
    loading: false,
    activeMembership: null,
  };
}

/**
 * The active tenant id, guaranteed non-null — for tenant-scoped pages.
 *
 * Such pages render behind AppLayout's tenant gate, which doesn't mount the
 * routed page until a tenant is resolved (loading spinner first; a "no tenant"
 * notice if the user has zero memberships). So by the time a page calls this,
 * a tenant exists. Throwing on null is a loud guard against rendering a
 * tenant-scoped page outside that gate (a wiring bug) — far better than
 * silently minting a token for a null tenant.
 */
export function useActiveTenantId(): TenantId {
  const { tenant } = useCurrentTenant();
  if (tenant == null) {
    throw new Error(
      'useActiveTenantId: no active tenant. Tenant-scoped pages must render ' +
        'inside the AppLayout tenant gate (or, in tests, a CurrentTenantProvider ' +
        'seeded with initialTenant).',
    );
  }
  return tenant;
}
