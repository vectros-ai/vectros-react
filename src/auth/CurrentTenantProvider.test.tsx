// ---------------------------------------------------------------------------
// CurrentTenantProvider tests — identity-driven membership loading.
//
// The provider sits ABOVE the router in every reference app, so it does NOT
// remount when a user navigates from the login page into the app after signing
// in. Its membership load must therefore key on the signed-in identity and
// re-run on every identity change (sign-in, sign-out, account swap) — a
// mount-only load would capture the pre-sign-in (no-session) state and never
// refresh, leaving the active tenant null and every scope-gated surface hidden
// until a full page reload.
//
// These tests exercise the provider directly (QueryClientProvider + AuthProvider
// + a mock adapter) so the contract is guarded in the package that owns it, not
// only via the consuming apps' integration tests.
// ---------------------------------------------------------------------------

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from './AuthProvider';
import { CurrentTenantProvider } from './CurrentTenantProvider';
import { useCurrentTenant } from './useCurrentTenant';
import { useAuth } from './useAuth';
import { __resetVectrosApiTokenCacheForTest } from './vectrosApiTokenCache';
import type { AuthProviderAdapter, AuthUser, TenantMembership } from './types';

const ALICE: AuthUser = { sub: 'sub-alice', email: 'alice@example.com', firstName: 'Alice', lastName: 'Smith' };
const BOB: AuthUser = { sub: 'sub-bob', email: 'bob@example.com', firstName: 'Bob', lastName: 'Jones' };

const ACME: TenantMembership = {
  tenantId: 'tnt_acme',
  tenantName: 'Acme',
  tenantKind: 'live',
  role: 'OWNER',
  status: 'ACTIVE',
  partnerId: 'p_acme',
};
const GLOBEX: TenantMembership = {
  tenantId: 'tnt_globex',
  tenantName: 'Globex',
  tenantKind: 'live',
  role: 'OWNER',
  status: 'ACTIVE',
  partnerId: 'p_globex',
};

/** Minimal AuthProviderAdapter test double — benign defaults; override per test. */
function makeMockAuthProvider(overrides: Partial<AuthProviderAdapter> = {}): AuthProviderAdapter {
  return {
    getCurrentUser: vi.fn().mockResolvedValue(null),
    signIn: vi.fn(),
    confirmSignIn: vi.fn(),
    signUp: vi.fn(),
    confirmSignUp: vi.fn().mockResolvedValue(undefined),
    resendSignUpCode: vi.fn().mockResolvedValue(undefined),
    forgotPassword: vi.fn().mockResolvedValue(undefined),
    confirmForgotPassword: vi.fn().mockResolvedValue(undefined),
    changePassword: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
    getIdToken: vi.fn().mockResolvedValue(null),
    getMemberships: vi.fn().mockResolvedValue([]),
    getActiveTenant: vi.fn().mockResolvedValue(null),
    getActivePartnerUserId: vi.fn().mockResolvedValue(null),
    setActiveTenant: vi.fn().mockResolvedValue(undefined),
    checkUserExists: vi.fn().mockResolvedValue({ exists: false, isMe: false }),
    linkInvitation: vi
      .fn()
      .mockResolvedValue({ tenantId: '', partnerUserId: '', role: 'SUB_USER', alreadyActive: false }),
    getMfaStatus: vi.fn().mockResolvedValue({ enabled: [], preferred: null }),
    setUpTotp: vi.fn().mockResolvedValue({ secret: 'MOCKSECRET234567', otpauthUri: 'otpauth://x' }),
    verifyTotpSetup: vi.fn().mockResolvedValue(undefined),
    disableTotp: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function wrapper(adapter: AuthProviderAdapter) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }): ReactElement => (
    <QueryClientProvider client={queryClient}>
      <AuthProvider provider={adapter}>
        <CurrentTenantProvider>{children}</CurrentTenantProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

/** Read the provider + auth together so a test can drive sign-in/out and observe tenant state. */
function renderProvider(adapter: AuthProviderAdapter) {
  return renderHook(() => ({ tenant: useCurrentTenant(), auth: useAuth() }), {
    wrapper: wrapper(adapter),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  __resetVectrosApiTokenCacheForTest();
});

describe('CurrentTenantProvider identity-driven load', () => {
  it('reloads memberships + active tenant when the user signs in AFTER mount (first-login regression)', async () => {
    // Mounts with no session (the provider is above the router → no remount on
    // the login→app navigation). A mount-only load would leave tenant null here
    // even after sign-in; the identity-keyed load must resolve it with no reload.
    let signedIn = false;
    const adapter = makeMockAuthProvider({
      getCurrentUser: vi.fn().mockImplementation(async () => (signedIn ? ALICE : null)),
      signIn: vi.fn().mockImplementation(async () => {
        signedIn = true;
        return { kind: 'COMPLETE' as const };
      }),
      getMemberships: vi.fn().mockImplementation(async () => (signedIn ? [ACME, GLOBEX] : [])),
      getActiveTenant: vi.fn().mockImplementation(async () => (signedIn ? 'tnt_acme' : null)),
    });
    const { result } = renderProvider(adapter);

    await waitFor(() => expect(result.current.tenant.loading).toBe(false));
    expect(result.current.tenant.tenant).toBeNull();

    await act(async () => {
      await result.current.auth.signIn({ email: ALICE.email, password: 'pw' });
    });

    await waitFor(() => expect(result.current.tenant.tenant).toBe('tnt_acme'));
    expect(result.current.tenant.memberships).toHaveLength(2);
  });

  it('clears memberships + active tenant when the user signs out', async () => {
    // Signed in at mount; signing out must drop the prior identity's tenant so
    // it can never bleed into the next session.
    let signedIn = true;
    const adapter = makeMockAuthProvider({
      getCurrentUser: vi.fn().mockImplementation(async () => (signedIn ? ALICE : null)),
      signOut: vi.fn().mockImplementation(async () => {
        signedIn = false;
      }),
      getMemberships: vi.fn().mockImplementation(async () => (signedIn ? [ACME] : [])),
      getActiveTenant: vi.fn().mockImplementation(async () => (signedIn ? 'tnt_acme' : null)),
    });
    const { result } = renderProvider(adapter);

    await waitFor(() => expect(result.current.tenant.tenant).toBe('tnt_acme'));

    await act(async () => {
      await result.current.auth.signOut();
    });

    await waitFor(() => expect(result.current.tenant.tenant).toBeNull());
    expect(result.current.tenant.memberships).toEqual([]);
  });

  it('reloads for the new identity when the signed-in user changes (account swap)', async () => {
    // Alice at mount → Bob after a fresh sign-in. The tenant must follow the new
    // identity, not stick on Alice's.
    let current: AuthUser = ALICE;
    const adapter = makeMockAuthProvider({
      getCurrentUser: vi.fn().mockImplementation(async () => current),
      signIn: vi.fn().mockImplementation(async () => {
        current = BOB;
        return { kind: 'COMPLETE' as const };
      }),
      getMemberships: vi
        .fn()
        .mockImplementation(async () => (current.sub === 'sub-bob' ? [GLOBEX] : [ACME])),
      getActiveTenant: vi
        .fn()
        .mockImplementation(async () => (current.sub === 'sub-bob' ? 'tnt_globex' : 'tnt_acme')),
    });
    const { result } = renderProvider(adapter);

    await waitFor(() => expect(result.current.tenant.tenant).toBe('tnt_acme'));

    await act(async () => {
      await result.current.auth.signIn({ email: BOB.email, password: 'pw' });
    });

    await waitFor(() => expect(result.current.tenant.tenant).toBe('tnt_globex'));
    expect(result.current.tenant.memberships).toEqual([GLOBEX]);
  });
});
