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
import type {
  AppContextSummary,
  ListAppContextsOptions,
  TenantId,
  TenantMembership,
  VectrosTenancyProvider,
} from './types';

/**
 * A real mount always supplies `tenancyProvider`; omitting it is a wiring
 * bug, not a supported degrade mode (see `CurrentTenantProviderProps.tenancyProvider`
 * doc). Every code path below that degrades in its absence — the load effect
 * and the three read-only pass-throughs below, which their own
 * `VectrosTenancyProvider` contract documents as "MUST NOT throw" even on a
 * real no-session case — routes through this ONE warning so the signal is
 * consistent and easy to grep for, rather than each path inventing its own
 * message (or, worse, staying silent). `setTenant`/`linkInvitation` do NOT
 * use this: those are mutating actions with no documented no-throw
 * requirement, so they throw instead — a caller attempting a write should
 * see a hard failure, not a silent no-op.
 */
function warnNoTenancyProvider(action: string): void {
  console.warn(
    `CurrentTenantProvider: ${action} called with no tenancyProvider supplied — returning an ` +
      'empty/no-op result. This is very likely a wiring bug (a real mount forgot to pass ' +
      'tenancyProvider), not a legitimate empty state — see CurrentTenantProviderProps.tenancyProvider.',
  );
}

export interface CurrentTenantProviderProps {
  readonly children: ReactNode;
  /**
   * The Vectros multi-tenant developer-portal adapter (a `CognitoAuthProvider`
   * instance, or anything else implementing `VectrosTenancyProvider`) — the
   * SAME object passed to `<AuthProvider provider={...}>` above it, typed to
   * its tenancy facet specifically. NOT read through `useAuth()`: multi-
   * tenancy is Vectros's own model, structurally inapplicable to a BYO-IdP
   * provider, so it isn't part of the generic auth context at all — see
   * `types.ts`'s `VectrosTenancyProvider` doc. Omit only when every consumer
   * below is seeded (tests/Storybook via `initialMemberships`); a real mount
   * with no `tenancyProvider` and no seed never resolves a tenant.
   */
  readonly tenancyProvider?: VectrosTenancyProvider;
  /**
   * Test/Storybook seed: when provided, the provider uses these memberships
   * (and `initialTenant`) directly and SKIPS the tenancyProvider-driven async
   * load entirely (`tenancyProvider` is then unused). Lets render helpers
   * exercise tenant-scoped pages without scripting getMemberships/getActiveTenant.
   */
  readonly initialMemberships?: ReadonlyArray<TenantMembership>;
  /** Test/Storybook seed for the active tenant id. */
  readonly initialTenant?: TenantId;
}

export function CurrentTenantProvider({
  children,
  tenancyProvider,
  initialMemberships,
  initialTenant,
}: CurrentTenantProviderProps): React.JSX.Element {
  const { user } = useAuth();
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
    if (!tenancyProvider) {
      // No tenancy adapter wired and nothing seeded — this mount can never
      // resolve a tenant. Warn once per effect run rather than fail silently.
      warnNoTenancyProvider('the membership load');
      setMemberships([]);
      setTenantState(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async (): Promise<void> => {
      try {
        const [list, active] = await Promise.all([
          tenancyProvider.getMemberships(),
          tenancyProvider.getActiveTenant(),
        ]);
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
  }, [seeded, userSub, tenancyProvider]);

  const setTenant = useCallback(
    async (next: TenantId): Promise<void> => {
      if (!tenancyProvider) {
        throw new Error('CurrentTenantProvider: cannot switch tenant — no tenancyProvider supplied.');
      }
      // Persist + refresh the JWT FIRST so the next partner-API mint (and any
      // developer-API call) resolves under the new tenant, THEN drop the
      // per-tenant token cache, switch locally, and refetch scoped data.
      await tenancyProvider.setActiveTenant(next);
      clearVectrosApiTokenCache();
      setTenantState(next);
      await queryClient.invalidateQueries();
    },
    [tenancyProvider, queryClient],
  );

  // Pass-throughs surfaced to descendants (e.g. app-vectros-ai's
  // CurrentContextProvider) that need the tenancy adapter but sit below this
  // provider, not above it — reading them from useCurrentTenant() rather than
  // threading tenancyProvider as a second prop everywhere it's needed.
  // getActivePartnerUserId defaults to null / listAppContexts to [] / checkUserExists
  // to "not found" when no tenancyProvider is wired, matching each method's own
  // documented "MUST NOT throw" contract — but still warns (warnNoTenancyProvider),
  // since the ONLY way this branch is reached is a missing tenancyProvider, never a
  // legitimate no-session case (that comes back from the real adapter call below,
  // not from this ternary) — so the warning is never a false alarm.
  const getActivePartnerUserId = useCallback(() => {
    if (!tenancyProvider) {
      warnNoTenancyProvider('getActivePartnerUserId');
      return Promise.resolve(null);
    }
    return tenancyProvider.getActivePartnerUserId();
  }, [tenancyProvider]);
  const listAppContexts = useCallback(
    (tenantId: TenantId, options?: ListAppContextsOptions): Promise<ReadonlyArray<AppContextSummary>> => {
      if (!tenancyProvider?.listAppContexts) {
        if (!tenancyProvider) warnNoTenancyProvider('listAppContexts');
        return Promise.resolve([]);
      }
      return tenancyProvider.listAppContexts(tenantId, options);
    },
    [tenancyProvider],
  );
  const checkUserExists = useCallback(
    (email: string) => {
      if (!tenancyProvider) {
        warnNoTenancyProvider('checkUserExists');
        return Promise.resolve({ exists: false, isMe: false });
      }
      return tenancyProvider.checkUserExists(email);
    },
    [tenancyProvider],
  );
  // Unlike the three read-only pass-throughs above, linkInvitation is a
  // mutating action with no "MUST NOT throw" contract — it throws on a
  // missing tenancyProvider rather than silently no-op'ing. Declared `async`
  // (not a plain arrow returning a throw) so that throw becomes a REJECTED
  // PROMISE, matching setTenant below and this function's own
  // `Promise<LinkInvitationResult>` return type — a bare synchronous throw
  // here would escape a caller's `.catch()` instead of being caught by it.
  const linkInvitation = useCallback(
    async (inviteToken: string) => {
      if (!tenancyProvider) {
        throw new Error('CurrentTenantProvider: cannot link an invitation — no tenancyProvider supplied.');
      }
      return tenancyProvider.linkInvitation(inviteToken);
    },
    [tenancyProvider],
  );

  const value = useMemo<CurrentTenantContextValue>(
    () => ({
      tenant,
      setTenant,
      memberships,
      loading,
      activeMembership: memberships.find((m) => m.tenantId === tenant) ?? null,
      getActivePartnerUserId,
      listAppContexts,
      checkUserExists,
      linkInvitation,
    }),
    [
      tenant,
      setTenant,
      memberships,
      loading,
      getActivePartnerUserId,
      listAppContexts,
      checkUserExists,
      linkInvitation,
    ],
  );

  return <CurrentTenantContext.Provider value={value}>{children}</CurrentTenantContext.Provider>;
}
