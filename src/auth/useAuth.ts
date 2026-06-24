// ---------------------------------------------------------------------------
// useAuth — the hook consumers use to read auth state + call auth operations.
//
// Throws if called outside an <AuthProvider> rather than returning a stale
// default. Failing loud at dev time is preferable to silently shipping a
// component that does no auth.
// ---------------------------------------------------------------------------

import { useContext } from 'react';

import { AuthContext } from './context';
import type { AuthContextValue } from './context';

/**
 * Returns the active AuthContextValue.
 *
 * @throws if the calling component is not rendered inside an `<AuthProvider>`.
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return ctx;
}
