// ---------------------------------------------------------------------------
// CurrentTenantProvider — context provider for useCurrentTenant.
//
// Loads the real membership set + active tenant from the auth adapter (via
// useAuth, so it stays provider-agnostic) and owns the tenant-switch
// orchestration. Lives in its own file (split from useCurrentTenant.ts) per the
// admin-app convention — matches AuthProvider.tsx + useAuth.ts.
//
// Sits inside <AuthProvider> (needs useAuth) AND <QueryClientProvider> (needs
// the query client to refetch tenant-scoped data on switch) — see main.tsx.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { useAuth } from './useAuth';
import { clearVectrosApiTokenCache } from './vectrosApiTokenCache';
import { CurrentTenantContext } from './useCurrentTenant';
import type { CurrentTenantContextValue } from './useCurrentTenant';
import type { TenantId, TenantMembership } from './types';

export interface CurrentTenantProviderProps {
  readonly children: ReactNode;
  /**
   * Test/Storybook seed: when provided, the provider uses these memberships
   * (and `initialTenant`) directly and SKIPS the useAuth-driven async load.
   * Lets render helpers exercise tenant-scoped pages without scripting the
   * adapter's getMemberships/getActiveTenant.
   */
  readonly initialMemberships?: ReadonlyArray<TenantMembership>;
  /** Test/Storybook seed for the active tenant id. */
  readonly initialTenant?: TenantId;
}

export function CurrentTenantProvider({
  children,
  initialMemberships,
  initialTenant,
}: CurrentTenantProviderProps): React.JSX.Element {
  const { getMemberships, getActiveTenant, setActiveTenant } = useAuth();
  const queryClient = useQueryClient();

  const seeded = initialMemberships !== undefined;
  const [memberships, setMemberships] = useState<ReadonlyArray<TenantMembership>>(
    initialMemberships ?? [],
  );
  const [tenant, setTenantState] = useState<TenantId | null>(initialTenant ?? null);
  // Loading only when we actually have to fetch (not when seeded for tests).
  const [loading, setLoading] = useState<boolean>(!seeded);

  // One-shot load of memberships + active tenant. Skipped when seeded.
  useEffect(() => {
    if (seeded) return;
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const [list, active] = await Promise.all([getMemberships(), getActiveTenant()]);
        if (cancelled) return;
        setMemberships(list);
        // Prefer the active_tenant claim when it names a real membership;
        // otherwise default to the first membership (or null if none).
        const resolved =
          active && list.some((m) => m.tenantId === active) ? active : (list[0]?.tenantId ?? null);
        setTenantState(resolved);
      } catch {
        // getMemberships swallows no-session as []; any other failure leaves
        // the user with no active tenant (pages show their empty/error state).
        if (!cancelled) {
          setMemberships([]);
          setTenantState(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [seeded, getMemberships, getActiveTenant]);

  const setTenant = useCallback(
    async (next: TenantId): Promise<void> => {
      // Persist + refresh the JWT FIRST so the next partner-API mint (and any
      // developer-API call) resolves under the new tenant, THEN drop the
      // per-tenant token cache, switch locally, and refetch scoped data.
      await setActiveTenant(next);
      clearVectrosApiTokenCache();
      setTenantState(next);
      await queryClient.invalidateQueries();
    },
    [setActiveTenant, queryClient],
  );

  const value = useMemo<CurrentTenantContextValue>(
    () => ({
      tenant,
      setTenant,
      memberships,
      loading,
      activeMembership: memberships.find((m) => m.tenantId === tenant) ?? null,
    }),
    [tenant, setTenant, memberships, loading],
  );

  return <CurrentTenantContext.Provider value={value}>{children}</CurrentTenantContext.Provider>;
}
