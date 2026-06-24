// ---------------------------------------------------------------------------
// Barrel exports for the auth module.
//
// Consumers import EVERYTHING they need from `./auth`:
//
//   import { useAuth, AuthProvider, CognitoAuthProvider } from '../auth';
//   import type { AuthUser, SignInResult } from '../auth';
//
// Forks swapping providers should add their own export here (e.g.
// `export { Auth0AuthProvider } from './providers/auth0';`) and remove
// the CognitoAuthProvider export if appropriate.
// ---------------------------------------------------------------------------

export { AuthProvider } from './AuthProvider';
export type { AuthProviderProps } from './AuthProvider';
export { useAuth } from './useAuth';
export type { AuthContextValue } from './context';

export { AuthError, isAuthError } from './errors';
export type { AuthErrorCode } from './errors';

export { authErrorToMessage } from './errorMessages';

export { useScopeGate } from './useScopeGate';
export type { ScopeGateValue } from './useScopeGate';
export { ScopeGate } from './ScopeGate';
export type { ScopeGateProps } from './ScopeGate';

export { useCurrentTenant, useActiveTenantId } from './useCurrentTenant';
export type { CurrentTenantContextValue, TenantMembership } from './useCurrentTenant';
export { CurrentTenantProvider } from './CurrentTenantProvider';
export type { CurrentTenantProviderProps } from './CurrentTenantProvider';

export { CognitoAuthProvider } from './providers/cognito';
export type { CognitoAuthProviderConfig } from './providers/cognito';

export {
  getVectrosApiToken,
  clearVectrosApiTokenCache,
  setPartnerApiTokenMinter,
} from './vectrosApiTokenCache';
export type { PartnerApiTokenMinter } from './vectrosApiTokenCache';

// Test-only cache resets — exported so consuming apps' test suites can isolate
// state between cases. Not part of the supported runtime API (the `__` prefix
// marks them internal): they only clear in-memory cache state and cannot bypass
// auth or scope checks (the backend re-verifies every request). A future minor
// may move these behind a `@vectros-ai/react/test` subpath export.
export { __resetVectrosApiTokenCacheForTest } from './vectrosApiTokenCache';
export { __resetScopeGateDecodeCacheForTest } from './useScopeGate';

export type {
  AppContextSummary,
  ListAppContextsOptions,
  AuthProviderAdapter,
  AuthUser,
  ChangePasswordInput,
  ConfirmForgotPasswordInput,
  ConfirmSignInInput,
  ConfirmSignUpInput,
  ForgotPasswordInput,
  MfaMethod,
  MfaStatus,
  SignInInput,
  SignInResult,
  SignUpInput,
  SignUpResult,
  TenantId,
  TotpSetupDetails,
  UserExistsResult,
} from './types';
