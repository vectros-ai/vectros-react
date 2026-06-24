// ---------------------------------------------------------------------------
// The React context object + its value type — extracted to its own file so
// the AuthProvider component file and the useAuth hook file can both depend
// on it WITHOUT mixing component + hook exports in a single module (which
// breaks Vite's HMR boundary detection — see the react-refresh ESLint rule).
//
// This file is an internal implementation detail of the auth module. The
// public surface for consumers is src/auth/index.ts (AuthProvider + useAuth).
// ---------------------------------------------------------------------------

import { createContext } from 'react';

import type {
  AuthUser,
  ChangePasswordInput,
  ConfirmForgotPasswordInput,
  ConfirmSignInInput,
  AppContextSummary,
  ListAppContextsOptions,
  ConfirmSignUpInput,
  ForgotPasswordInput,
  MfaStatus,
  SignInInput,
  SignInResult,
  LinkInvitationResult,
  SignUpInput,
  SignUpResult,
  TenantId,
  TenantMembership,
  TotpSetupDetails,
  UserExistsResult,
} from './types';

/**
 * The value exposed by useAuth(). All operations are provider-agnostic and
 * mirror the AuthProviderAdapter contract one-for-one, with two additions:
 *   - `loading` — true during the initial getCurrentUser() probe.
 *   - `isAuthenticated` — convenience derived from `user`.
 *
 * Operations that change session state (signIn/confirmSignIn/signOut) re-fetch
 * the user via the adapter and update local state. Operations that don't
 * change session state (signUp/forgotPassword/etc.) pass through unchanged.
 */
export interface AuthContextValue {
  readonly user: AuthUser | null;
  readonly loading: boolean;
  readonly isAuthenticated: boolean;
  readonly signIn: (input: SignInInput) => Promise<SignInResult>;
  readonly confirmSignIn: (input: ConfirmSignInInput) => Promise<SignInResult>;
  readonly signUp: (input: SignUpInput) => Promise<SignUpResult>;
  readonly confirmSignUp: (input: ConfirmSignUpInput) => Promise<void>;
  readonly resendSignUpCode: (input: { readonly email: string }) => Promise<void>;
  readonly forgotPassword: (input: ForgotPasswordInput) => Promise<void>;
  readonly confirmForgotPassword: (input: ConfirmForgotPasswordInput) => Promise<void>;
  readonly changePassword: (input: ChangePasswordInput) => Promise<void>;
  readonly signOut: () => Promise<void>;
  readonly getIdToken: () => Promise<string | null>;
  // Multi-tenancy — pass-through to the adapter so consumers
  // (TenantSwitcher, useCurrentTenant) stay provider-agnostic.
  readonly getMemberships: () => Promise<ReadonlyArray<TenantMembership>>;
  readonly getActiveTenant: () => Promise<TenantId | null>;
  readonly getActivePartnerUserId: () => Promise<string | null>;
  readonly setActiveTenant: (tenantId: TenantId) => Promise<void>;
  readonly checkUserExists: (email: string) => Promise<UserExistsResult>;
  readonly linkInvitation: (inviteToken: string) => Promise<LinkInvitationResult>;
  /**
   * List the reachable AppContexts in a tenant (data-plane context switcher).
   * Always present here even though the adapter method is optional — AuthProvider
   * supplies a `[]` fallback when the adapter omits it, so consumers needn't
   * null-check.
   */
  readonly listAppContexts: (
    tenantId: TenantId,
    options?: ListAppContextsOptions,
  ) => Promise<ReadonlyArray<AppContextSummary>>;
  // Multi-factor auth — pass-through to the adapter so the /account
  // page + enrollment wizard stay provider-agnostic.
  readonly getMfaStatus: () => Promise<MfaStatus>;
  readonly setUpTotp: () => Promise<TotpSetupDetails>;
  readonly verifyTotpSetup: (code: string) => Promise<void>;
  readonly disableTotp: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
