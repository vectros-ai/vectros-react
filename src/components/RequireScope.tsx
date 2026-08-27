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
import type { TenantId } from '../auth/types';

export interface RequireScopeProps {
  /**
   * The action the route requires — the compact `resource:ops` form (e.g.
   * `'users:r'`) unions ops across every unqualified matching grant; any
   * other shape matches only verbatim. Wildcard `*` grants all. See
   * {@link canPerform} for the exact rules.
   */
  readonly action: string;
  /** The signed-in, allowed content. */
  readonly children: ReactNode;
  /** Path to redirect to when the action is not allowed. Defaults to `/`. */
  readonly redirectTo?: string;
  /**
   * Forwarded to `useScopeGate` as its own `tenantOverride` — see
   * {@link ScopeGateProps.tenantOverride} for the full rationale. A
   * single-tenant host with no `CurrentTenantProvider` in its tree MUST
   * supply this, or the gate never resolves (`loading` stays true forever)
   * and this route renders nothing, permanently — never the content, never
   * the redirect.
   */
  readonly tenantOverride?: TenantId;
}

export function RequireScope({
  action,
  children,
  redirectTo = '/',
  tenantOverride,
}: RequireScopeProps): React.JSX.Element {
  const gate = useScopeGate(tenantOverride);

  if (gate.loading) return <>{null}</>;
  if (!gate.can(action)) return <Navigate to={redirectTo} replace />;
  return <>{children}</>;
}
