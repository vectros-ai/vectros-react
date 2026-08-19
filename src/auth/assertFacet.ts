// ---------------------------------------------------------------------------
// assertEmbeddedAuth / assertHostedAuth — narrow useAuth()'s loose
// AuthContextValue to a specific facet, with a REAL runtime check backing
// the narrowing (not a bare `as` cast).
//
// WHY THIS EXISTS (the design question a code review raised): a consuming
// app that always uses one provider shape (e.g. admin-app is always
// Cognito/embedded) wants `useAuth()` to return fully-typed, non-optional
// methods so its ~15 call sites don't need per-call optional-chaining. The
// naive way to get that is an unchecked `useAuthBase() as AuthContextValue &
// EmbeddedCredentialAuth` — accurate today, but nothing catches it if a
// future change repoints that app's `main.tsx` at a hosted-redirect provider
// without also updating the cast: the app keeps compiling, and every
// embedded call site throws `TypeError: ... is not a function` at runtime
// instead.
//
// The deeper alternative — making `AuthProvider`/`useAuth` themselves
// generic over the provider's facet — was considered and rejected: React
// `createContext` produces ONE context object with ONE static type, so a
// "generic AuthProvider" still needs a cast or an assertion at the point
// something reads that monomorphic context and treats it as narrower than
// its declared type. The generic version doesn't eliminate the boundary
// assertion, it just moves it — and moving it costs a second Context object
// (or a runtime discriminant threaded through every consumer) for no extra
// safety over asserting once, right here, at the one narrowing boundary each
// app already has.
//
// So: keep the narrowing at the boundary, but make it a real TypeScript
// ASSERTION FUNCTION (`asserts value is X`) instead of a cast — same
// ergonomics for callers (the return type is still fully narrowed), but
// backed by an actual runtime check that fails LOUD, immediately, with a
// clear message, the first time ANY component calls `useAuth()` after a
// provider/wrapper mismatch — not silently, and not only at the specific
// call site of whichever method happens to be missing.
// ---------------------------------------------------------------------------

import type { AuthContextValue } from './context';
import type { EmbeddedCredentialAuth, HostedRedirectAuth } from './types';

/**
 * Assert that `value` (a `useAuth()` result) comes from a provider
 * implementing {@link EmbeddedCredentialAuth}, narrowing the type
 * accordingly. Throws immediately, with a clear diagnostic, if it doesn't —
 * e.g. the app's `<AuthProvider>` was wired with a hosted-redirect provider
 * (like `Auth0AuthProvider`) instead of an embedded one (like
 * `CognitoAuthProvider`).
 *
 * Intended use: an app that always uses one embedded-credential provider
 * calls this once, in its own local `useAuth()` wrapper, so every other call
 * site in the app stays fully typed with no optional-chaining:
 *
 * ```ts
 * export function useAuth(): AuthContextValue & EmbeddedCredentialAuth {
 *   const value = useAuthBase();
 *   assertEmbeddedAuth(value);
 *   return value;
 * }
 * ```
 */
export function assertEmbeddedAuth(
  value: AuthContextValue,
): asserts value is AuthContextValue & EmbeddedCredentialAuth {
  if (typeof value.signIn !== 'function') {
    throw new Error(
      'assertEmbeddedAuth: the configured AuthProvider does not implement EmbeddedCredentialAuth ' +
        '(no signIn method present). This usually means <AuthProvider> was wired with a ' +
        'hosted-redirect provider (e.g. Auth0AuthProvider) but the app code assumes an ' +
        'embedded-credential one (e.g. CognitoAuthProvider) — check the provider constructed in main.tsx.',
    );
  }
}

/**
 * Assert that `value` (a `useAuth()` result) comes from a provider
 * implementing {@link HostedRedirectAuth}, narrowing the type accordingly.
 * The hosted-redirect counterpart to {@link assertEmbeddedAuth} — see its
 * doc for the full rationale.
 */
export function assertHostedAuth(
  value: AuthContextValue,
): asserts value is AuthContextValue & HostedRedirectAuth {
  if (typeof value.signInWithRedirect !== 'function') {
    throw new Error(
      'assertHostedAuth: the configured AuthProvider does not implement HostedRedirectAuth ' +
        '(no signInWithRedirect method present). This usually means <AuthProvider> was wired with ' +
        'an embedded-credential provider (e.g. CognitoAuthProvider) but the app code assumes a ' +
        'hosted-redirect one (e.g. Auth0AuthProvider) — check the provider constructed in main.tsx.',
    );
  }
}
