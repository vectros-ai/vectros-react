// ---------------------------------------------------------------------------
// RequireAuth — route guard.
//
// Behavior:
//   - While the AuthProvider's initial session probe is in flight (`loading`),
//     render a centered spinner. This avoids the flash-of-redirect when the
//     user IS signed in but useAuth() hasn't resolved yet on first render.
//   - When the probe completes and there is no session, redirect to
//     `redirectTo` (default `/login`) with `state.from = current location`
//     so the LoginPage can route the user back to their intended destination
//     after sign-in.
//   - When authenticated, render children unchanged.
//
// The component is auth-provider-agnostic — it reads only `isAuthenticated`
// and `loading` from useAuth(), both normalized at the adapter boundary.
// ---------------------------------------------------------------------------

import { Box, CircularProgress } from '@mui/material';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useIntl } from 'react-intl';

import { useAuth } from '../auth';

export interface RequireAuthProps {
  readonly children: ReactNode;
  /** Path to redirect to when unauthenticated. Defaults to `/login`. */
  readonly redirectTo?: string;
}

export function RequireAuth({
  children,
  redirectTo = '/login',
}: RequireAuthProps): React.JSX.Element {
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();
  const intl = useIntl();

  if (loading) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '60vh',
        }}
      >
        <CircularProgress aria-label={intl.formatMessage({ id: 'layout.loadingSession' })} />
      </Box>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to={redirectTo} state={{ from: location }} replace />;
  }

  return <>{children}</>;
}
