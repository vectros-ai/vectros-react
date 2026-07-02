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
  const { user, getMemberships, getActiveTenant, setActiveTenant } = useAuth();
  const queryClient = useQueryClient();

  const seeded = initialMemberships !== undefined;
  const [memberships, setMemberships] = useState<ReadonlyArray<TenantMembership>>(
    initialMemberships ?? [],
  );
  const [tenant, setTenantState] = useState<TenantId | null>(initialTenant ?? null);
  // Loading only when we actually have to fetch (not when seeded for tests).
  const [loading, setLoading] = useState<boolean>(!seeded);

  // Identity of the signed-in user; the membership load keys on this so it
  // RE-RUNS when the user signs in (see the effect below).
  const userSub = user?.sub ?? null;

  // Load memberships + the active tenant from the auth adapter, and RE-LOAD
  // whenever the signed-in identity changes. Skipped when seeded (tests).
  //
  // Keying on the user's identity — not just the first mount — is essential:
  // this provider sits ABOVE the router, so it does NOT remount when the user
  // navigates from the login page into the app after signing in. A mount-only
  // load would run exactly once, BEFORE sign-in when there is no session, read
  // an empty membership set, and never run again — leaving the active tenant
  // null and every scope-gated surface (the entire sidebar nav) hidden until a
  // full page reload. Re-running on the identity change resolves the tenant the
  // moment the user signs in, so the menu renders correctly on the first login.
  useEffect(() => {
    if (seeded) return;
    let cancelled = false;
    setLoading(true);
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
  }, [seeded, userSub, getMemberships, getActiveTenant]);

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
