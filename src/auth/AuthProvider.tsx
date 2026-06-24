// ---------------------------------------------------------------------------
// <AuthProvider> — the React component that owns auth state and exposes it
// via context. Wraps any AuthProviderAdapter implementation, so the UI tree
// stays identity-provider-agnostic.
//
// Pattern:
//   - main.tsx instantiates ONE adapter and passes it to <AuthProvider provider={...}>.
//   - Tests pass an inline mock satisfying AuthProviderAdapter.
//   - All consumers (LoginPage, RequireAuth, AcceptPage, etc.) call
//     `useAuth()` and operate against the normalized DTOs in ./types.ts.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { AuthContext } from './context';
import type { AuthContextValue } from './context';
import { clearVectrosApiTokenCache } from './vectrosApiTokenCache';
import type {
  AuthProviderAdapter,
  AuthUser,
  ChangePasswordInput,
  ConfirmForgotPasswordInput,
  ConfirmSignInInput,
  ConfirmSignUpInput,
  ForgotPasswordInput,
  ListAppContextsOptions,
  SignInInput,
  SignInResult,
  SignUpInput,
  SignUpResult,
  TenantId,
} from './types';

export interface AuthProviderProps {
  /** The concrete identity-provider adapter (Cognito / Auth0 / mock / etc.). */
  readonly provider: AuthProviderAdapter;
  readonly children: ReactNode;
}

export function AuthProvider({ provider, children }: AuthProviderProps): React.JSX.Element {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshUser = useCallback(async (): Promise<void> => {
    const current = await provider.getCurrentUser();
    setUser(current);
  }, [provider]);

  // Initial session probe on mount. The cancelled flag prevents a stale
  // setState if the component unmounts mid-flight (e.g. provider hot-swap).
  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const current = await provider.getCurrentUser();
        if (!cancelled) setUser(current);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [provider]);

  const signIn = useCallback(
    async (input: SignInInput): Promise<SignInResult> => {
      const result = await provider.signIn(input);
      if (result.kind === 'COMPLETE') {
        await refreshUser();
      }
      return result;
    },
    [provider, refreshUser],
  );

  const confirmSignIn = useCallback(
    async (input: ConfirmSignInInput): Promise<SignInResult> => {
      const result = await provider.confirmSignIn(input);
      if (result.kind === 'COMPLETE') {
        await refreshUser();
      }
      return result;
    },
    [provider, refreshUser],
  );

  const signUp = useCallback(
    (input: SignUpInput): Promise<SignUpResult> => provider.signUp(input),
    [provider],
  );
  const confirmSignUp = useCallback(
    (input: ConfirmSignUpInput): Promise<void> => provider.confirmSignUp(input),
    [provider],
  );
  const resendSignUpCode = useCallback(
    (input: { readonly email: string }): Promise<void> => provider.resendSignUpCode(input),
    [provider],
  );
  const forgotPassword = useCallback(
    (input: ForgotPasswordInput): Promise<void> => provider.forgotPassword(input),
    [provider],
  );
  const confirmForgotPassword = useCallback(
    (input: ConfirmForgotPasswordInput): Promise<void> => provider.confirmForgotPassword(input),
    [provider],
  );
  const changePassword = useCallback(
    (input: ChangePasswordInput): Promise<void> => provider.changePassword(input),
    [provider],
  );
  const signOut = useCallback(async (): Promise<void> => {
    await provider.signOut();
    // Clear the Vectros-API token cache (+ bump its generation counter, so
    // any in-flight mint that hasn't resolved yet is discarded — see
    // vectrosApiTokenCache.ts module comment for the cross-identity-leak
    // threat model). Calling this here means EVERY sign-out path —
    // explicit user click, session-expiry redirect, etc. — gets the same
    // cleanup, not just the one wired into AppLayout's menu.
    clearVectrosApiTokenCache();
    setUser(null);
  }, [provider]);
  const getIdToken = useCallback((): Promise<string | null> => provider.getIdToken(), [provider]);

  // Multi-tenancy pass-throughs. No local state here — the
  // adapter owns the source of truth (JWT claims / developer API); the
  // CurrentTenantProvider layers React state + persistence on top of these.
  const getMemberships = useCallback(() => provider.getMemberships(), [provider]);
  const getActiveTenant = useCallback(() => provider.getActiveTenant(), [provider]);
  const getActivePartnerUserId = useCallback(
    () => provider.getActivePartnerUserId(),
    [provider],
  );
  const setActiveTenant = useCallback(
    (tenantId: TenantId): Promise<void> => provider.setActiveTenant(tenantId),
    [provider],
  );
  const checkUserExists = useCallback(
    (email: string) => provider.checkUserExists(email),
    [provider],
  );
  const linkInvitation = useCallback(
    (inviteToken: string) => provider.linkInvitation(inviteToken),
    [provider],
  );
  // Optional adapter method — supply a `[]` fallback so consumers (the
  // data-plane context switcher) needn't null-check a provider that omits it.
  const listAppContexts = useCallback(
    (tenantId: TenantId, options?: ListAppContextsOptions) =>
      provider.listAppContexts
        ? provider.listAppContexts(tenantId, options)
        : Promise.resolve([]),
    [provider],
  );

  // Multi-factor auth pass-throughs. Stateless — the adapter owns
  // the source of truth (Cognito MFA preference); the /account page layers
  // TanStack Query on top of getMfaStatus.
  const getMfaStatus = useCallback(() => provider.getMfaStatus(), [provider]);
  const setUpTotp = useCallback(() => provider.setUpTotp(), [provider]);
  const verifyTotpSetup = useCallback(
    (code: string): Promise<void> => provider.verifyTotpSetup(code),
    [provider],
  );
  const disableTotp = useCallback((): Promise<void> => provider.disableTotp(), [provider]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      isAuthenticated: user !== null,
      signIn,
      confirmSignIn,
      signUp,
      confirmSignUp,
      resendSignUpCode,
      forgotPassword,
      confirmForgotPassword,
      changePassword,
      signOut,
      getIdToken,
      getMemberships,
      getActiveTenant,
      getActivePartnerUserId,
      setActiveTenant,
      checkUserExists,
      linkInvitation,
      listAppContexts,
      getMfaStatus,
      setUpTotp,
      verifyTotpSetup,
      disableTotp,
    }),
    [
      user,
      loading,
      signIn,
      confirmSignIn,
      signUp,
      confirmSignUp,
      resendSignUpCode,
      forgotPassword,
      confirmForgotPassword,
      changePassword,
      signOut,
      getIdToken,
      getMemberships,
      getActiveTenant,
      getActivePartnerUserId,
      setActiveTenant,
      checkUserExists,
      linkInvitation,
      listAppContexts,
      getMfaStatus,
      setUpTotp,
      verifyTotpSetup,
      disableTotp,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
