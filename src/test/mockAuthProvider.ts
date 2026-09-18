// ---------------------------------------------------------------------------
// makeMockAuthProvider — shared test double for the full AuthProviderAdapter
// + EmbeddedCredentialAuth + VectrosTenancyProvider shape (what
// CognitoAuthProvider implements) — used by this package's OWN tests that
// need a full mock (AppLayout.test.tsx, CurrentTenantProvider.test.tsx).
//
// A near-identical shape (same interface, same defaults) is kept as its own copy in each
// consuming app's own test tree, rather than a shared export, because those apps can't
// depend on this package's test-only code — but the shape itself should stay in sync
// across copies; if you change one, check the others.
//
// Every method defaults to a `vi.fn()` with a benign resolved value so a
// component under test never hits an undefined method; pass `overrides` to
// pin the behavior a specific test cares about.
// ---------------------------------------------------------------------------

import { vi } from 'vitest';

import type {
  AuthProviderAdapter,
  EmbeddedCredentialAuth,
  VectrosTenancyProvider,
} from '../auth/types';

/** The full shape CognitoAuthProvider implements — what these tests mock. */
export type FullMockProvider = AuthProviderAdapter & EmbeddedCredentialAuth & VectrosTenancyProvider;

export function makeMockAuthProvider(
  overrides: Partial<FullMockProvider> = {},
): FullMockProvider {
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
    setUpTotp: vi.fn().mockResolvedValue({
      secret: 'MOCKSECRET234567',
      otpauthUri: 'otpauth://totp/Mock:me?secret=MOCKSECRET234567&issuer=Mock',
    }),
    verifyTotpSetup: vi.fn().mockResolvedValue(undefined),
    disableTotp: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}
