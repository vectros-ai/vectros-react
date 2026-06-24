// ---------------------------------------------------------------------------
// RequireScope — route guard for scope-gated pages.
//
// Hiding a nav link is cosmetic: the route is still reachable by typing the
// URL. RequireScope closes that gap at the route boundary — a user without the
// required action is redirected away instead of landing on a page whose API
// calls will fail. (The backend remains the authority and re-verifies every
// request; this is the client-side defense-in-depth + UX layer.)
//
// Behavior:
//   - While the scope gate is resolving (`loading`), render nothing — avoids a
//     flash-of-redirect before the token's actions are known.
//   - When resolved and the action is not allowed, redirect to `redirectTo`
//     (default `/`, the ungated landing).
//   - When allowed, render children unchanged.
//
// Pair with the matching nav `gateAction` so the link and the route agree.
// ---------------------------------------------------------------------------

import type { ReactNode } from 'react';
import { Navigate } from 'react-router';

import { useScopeGate } from '../auth/useScopeGate';

export interface RequireScopeProps {
  /** The action the route requires. Matches verbatim against allowed actions; wildcard `*` grants all. */
  readonly action: string;
  /** The signed-in, allowed content. */
  readonly children: ReactNode;
  /** Path to redirect to when the action is not allowed. Defaults to `/`. */
  readonly redirectTo?: string;
}

export function RequireScope({
  action,
  children,
  redirectTo = '/',
}: RequireScopeProps): React.JSX.Element {
  const gate = useScopeGate();

  if (gate.loading) return <>{null}</>;
  if (!gate.can(action)) return <Navigate to={redirectTo} replace />;
  return <>{children}</>;
}
