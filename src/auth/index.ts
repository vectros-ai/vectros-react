// ---------------------------------------------------------------------------
// Barrel exports for the auth module.
//
// Consumers import the shared runtime (AuthProvider/useAuth/types/etc.) from
// `./auth`, but import a concrete PROVIDER's value from its own subpath:
//
//   import { AuthProvider, useAuth } from '../auth';
//   import type { AuthUser, SignInResult } from '../auth';
//   import { CognitoAuthProvider } from '@vectros-ai/react/providers/cognito';
//   import { Auth0AuthProvider } from '@vectros-ai/react/providers/auth0';
//
// Do NOT value-export a concrete provider from this barrel (see the
// CognitoAuthProvider/Auth0AuthProvider section below) — that would pull
// its SDK's runtime import into every consumer's bundle regardless of which
// provider they actually use. A fork adding a new provider follows the same
// pattern: its own file under `./providers/`, its own tsup entry point +
// package.json export subpath, type-only exported from this barrel.
// ---------------------------------------------------------------------------

export { AuthProvider } from './AuthProvider';
export type { AuthProviderProps } from './AuthProvider';
export { useAuth } from './useAuth';
export type { AuthContextValue } from './context';
export { assertEmbeddedAuth, assertHostedAuth } from './assertFacet';

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

// CognitoAuthProvider / Auth0AuthProvider are DELIBERATELY NOT value-exported
// here — only their TYPES are (type-only exports are erased at build time,
// so they cost nothing and don't pull either SDK's runtime import into this
// bundle). Import the concrete class from its own subpath instead:
//   import { CognitoAuthProvider } from '@vectros-ai/react/providers/cognito';
//   import { Auth0AuthProvider } from '@vectros-ai/react/providers/auth0';
// See tsup.config.ts's file header for why this split exists.
export type { CognitoAuthProvider, CognitoAuthProviderConfig } from './providers/cognito';
export type { Auth0AuthProvider, Auth0AuthProviderConfig } from './providers/auth0';

export {
  getVectrosApiToken,
  getVectrosResolvedScope,
  clearVectrosApiTokenCache,
  setPartnerApiTokenMinter,
  setPartnerApiTokenAssumer,
} from './vectrosApiTokenCache';
export type {
  PartnerApiResolvedScope,
  PartnerApiTokenMinter,
  PartnerApiTokenAssumer,
  VectrosIdentityOverride,
} from './vectrosApiTokenCache';

// Test-only cache resets — exported so consuming apps' test suites can isolate
// state between cases. Not part of the supported runtime API (the `__` prefix
// marks them internal): they only clear in-memory cache state and cannot bypass
// auth or scope checks (the backend re-verifies every request). A future minor
// may move these behind a `@vectros-ai/react/test` subpath export.
export { __resetVectrosApiTokenCacheForTest } from './vectrosApiTokenCache';

export type {
  AppContextSummary,
  ListAppContextsOptions,
  AuthProviderAdapter,
  EmbeddedCredentialAuth,
  HostedRedirectAuth,
  VectrosTenancyProvider,
  AuthUser,
  ChangePasswordInput,
  ConfirmForgotPasswordInput,
  ConfirmSignInInput,
  ConfirmSignUpInput,
  ForgotPasswordInput,
  LinkInvitationResult,
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
