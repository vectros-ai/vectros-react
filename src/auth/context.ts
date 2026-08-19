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
  ConfirmSignUpInput,
  ForgotPasswordInput,
  MfaStatus,
  SignInInput,
  SignInResult,
  SignUpInput,
  SignUpResult,
  TotpSetupDetails,
} from './types';

/**
 * The value exposed by useAuth(). Provider-agnostic core is always present;
 * embedded-credential and hosted-redirect methods are each present ONLY when
 * the concrete provider passed to `<AuthProvider>` actually implements that
 * interface (see `types.ts`'s file-header note on why the split exists) —
 * `<AuthProvider>` detects this at construction and omits the whole group
 * otherwise, rather than expose a method that would always throw.
 *
 * Multi-tenancy (`getMemberships`/etc.) is deliberately NOT here at all —
 * it's Vectros's own Cognito-backed model, structurally inapplicable to any
 * BYO-IdP/token-exchange provider. Consumers that need it
 * (`CurrentTenantProvider`) take a `VectrosTenancyProvider` as an explicit
 * prop instead. See `types.ts`'s `VectrosTenancyProvider` doc.
 *
 * A consuming app that always uses one provider (e.g. admin-app is always
 * Cognito/embedded) can narrow this once, in its own `useAuth()` wrapper —
 * see `ui/admin-app/src/auth/index.ts` — so its many call sites keep calling
 * `useAuth().signIn(...)` unchanged, fully typed, with no per-call-site
 * optional-chaining.
 */
export interface AuthContextValue {
  readonly user: AuthUser | null;
  readonly loading: boolean;
  readonly isAuthenticated: boolean;
  readonly signOut: () => Promise<void>;
  readonly getIdToken: () => Promise<string | null>;

  // Embedded-credential methods — present only for an embedded-mode provider
  // (e.g. CognitoAuthProvider). signIn/confirmSignIn re-fetch the user via
  // the adapter and update local state on COMPLETE; the rest pass through
  // unchanged (they don't themselves change session state).
  readonly signIn?: (input: SignInInput) => Promise<SignInResult>;
  readonly confirmSignIn?: (input: ConfirmSignInInput) => Promise<SignInResult>;
  readonly signUp?: (input: SignUpInput) => Promise<SignUpResult>;
  readonly confirmSignUp?: (input: ConfirmSignUpInput) => Promise<void>;
  readonly resendSignUpCode?: (input: { readonly email: string }) => Promise<void>;
  readonly forgotPassword?: (input: ForgotPasswordInput) => Promise<void>;
  readonly confirmForgotPassword?: (input: ConfirmForgotPasswordInput) => Promise<void>;
  readonly changePassword?: (input: ChangePasswordInput) => Promise<void>;
  readonly getMfaStatus?: () => Promise<MfaStatus>;
  readonly setUpTotp?: () => Promise<TotpSetupDetails>;
  readonly verifyTotpSetup?: (code: string) => Promise<void>;
  readonly disableTotp?: () => Promise<void>;

  // Hosted-redirect methods — present only for a hosted-redirect provider
  // (e.g. an Auth0-via-Universal-Login adapter). handleRedirectCallback
  // re-fetches the user via the adapter on success, same as signIn above.
  readonly signInWithRedirect?: (options?: { readonly returnTo?: string }) => Promise<void>;
  readonly handleRedirectCallback?: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
