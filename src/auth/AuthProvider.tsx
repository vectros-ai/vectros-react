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
  EmbeddedCredentialAuth,
  ForgotPasswordInput,
  HostedRedirectAuth,
  SignInInput,
  SignInResult,
  SignUpInput,
  SignUpResult,
} from './types';

/**
 * What `<AuthProvider>` actually accepts: the required core, PLUS either or
 * both of the embedded/hosted extension interfaces, each as an optional
 * facet detected at runtime (see `hasEmbedded`/`hasHosted` below) — never
 * both required, never neither meaningful. A concrete provider's real type
 * (e.g. `CognitoAuthProvider`, which implements core + embedded) narrows this
 * structurally; nothing here forces it to implement facets it doesn't have.
 */
type AnyAuthProvider = AuthProviderAdapter &
  Partial<EmbeddedCredentialAuth> &
  Partial<HostedRedirectAuth>;

export interface AuthProviderProps {
  /** The concrete identity-provider adapter (Cognito / Auth0 / mock / etc.). */
  readonly provider: AnyAuthProvider;
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

  // ---------------------------------------------------------------------
  // Embedded-credential facet — present only when the concrete provider
  // implements it (checked once via a stable capability probe: `signIn` is
  // EmbeddedCredentialAuth's entry point, so its presence stands in for the
  // whole interface — a provider either implements the full embedded shape
  // or none of it, per types.ts's file-header note).
  // ---------------------------------------------------------------------
  const hasEmbedded = typeof provider.signIn === 'function';

  const signIn = useCallback(
    async (input: SignInInput): Promise<SignInResult> => {
      const result = await provider.signIn!(input);
      if (result.kind === 'COMPLETE') {
        await refreshUser();
      }
      return result;
    },
    [provider, refreshUser],
  );
  const confirmSignIn = useCallback(
    async (input: ConfirmSignInInput): Promise<SignInResult> => {
      const result = await provider.confirmSignIn!(input);
      if (result.kind === 'COMPLETE') {
        await refreshUser();
      }
      return result;
    },
    [provider, refreshUser],
  );
  const signUp = useCallback(
    (input: SignUpInput): Promise<SignUpResult> => provider.signUp!(input),
    [provider],
  );
  const confirmSignUp = useCallback(
    (input: ConfirmSignUpInput): Promise<void> => provider.confirmSignUp!(input),
    [provider],
  );
  const resendSignUpCode = useCallback(
    (input: { readonly email: string }): Promise<void> => provider.resendSignUpCode!(input),
    [provider],
  );
  const forgotPassword = useCallback(
    (input: ForgotPasswordInput): Promise<void> => provider.forgotPassword!(input),
    [provider],
  );
  const confirmForgotPassword = useCallback(
    (input: ConfirmForgotPasswordInput): Promise<void> => provider.confirmForgotPassword!(input),
    [provider],
  );
  const changePassword = useCallback(
    (input: ChangePasswordInput): Promise<void> => provider.changePassword!(input),
    [provider],
  );
  const getMfaStatus = useCallback(() => provider.getMfaStatus!(), [provider]);
  const setUpTotp = useCallback(() => provider.setUpTotp!(), [provider]);
  const verifyTotpSetup = useCallback(
    (code: string): Promise<void> => provider.verifyTotpSetup!(code),
    [provider],
  );
  const disableTotp = useCallback((): Promise<void> => provider.disableTotp!(), [provider]);

  // ---------------------------------------------------------------------
  // Hosted-redirect facet — present only when the concrete provider
  // implements it. `signInWithRedirect` is HostedRedirectAuth's entry point,
  // standing in for the whole (two-method) interface.
  // ---------------------------------------------------------------------
  const hasHosted = typeof provider.signInWithRedirect === 'function';

  const signInWithRedirect = useCallback(
    (options?: { readonly returnTo?: string }): Promise<void> =>
      provider.signInWithRedirect!(options),
    [provider],
  );
  const handleRedirectCallback = useCallback(async (): Promise<void> => {
    await provider.handleRedirectCallback!();
    // Unlike embedded's signIn/confirmSignIn, there's no SignInResult to
    // branch on here — the redirect either produced a session or threw.
    // Refresh unconditionally; getCurrentUser stays null if it didn't.
    await refreshUser();
  }, [provider, refreshUser]);
  const acceptInvite = useCallback(
    (inviteToken: string): Promise<void> => provider.acceptInvite!(inviteToken),
    [provider],
  );

  const value = useMemo<AuthContextValue>(() => {
    const core = { user, loading, isAuthenticated: user !== null, signOut, getIdToken };
    const embedded = hasEmbedded
      ? {
          signIn,
          confirmSignIn,
          signUp,
          confirmSignUp,
          resendSignUpCode,
          forgotPassword,
          confirmForgotPassword,
          changePassword,
          getMfaStatus,
          setUpTotp,
          verifyTotpSetup,
          disableTotp,
        }
      : {};
    const hosted = hasHosted ? { signInWithRedirect, handleRedirectCallback, acceptInvite } : {};
    return { ...core, ...embedded, ...hosted };
  }, [
    user,
    loading,
    signOut,
    getIdToken,
    hasEmbedded,
    signIn,
    confirmSignIn,
    signUp,
    confirmSignUp,
    resendSignUpCode,
    forgotPassword,
    confirmForgotPassword,
    changePassword,
    getMfaStatus,
    setUpTotp,
    verifyTotpSetup,
    disableTotp,
    hasHosted,
    signInWithRedirect,
    handleRedirectCallback,
    acceptInvite,
  ]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
