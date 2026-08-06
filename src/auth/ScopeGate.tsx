// ---------------------------------------------------------------------------
// <ScopeGate> — declarative wrapper for useScopeGate.
//
// Renders `children` only when the gate's `can(action)` returns true.
// During loading, renders nothing (the `fallback` is for the gate-denied
// case, not the loading case — for that, the consumer renders a skeleton
// or simply hides the gated surface).
//
// Example:
//   <ScopeGate action="users:r">
//     <NavLink to="/members">Members</NavLink>
//   </ScopeGate>
//
// Lives in its own file (vs. inline in useScopeGate.ts) per the admin-app
// convention: hooks and components are split for react-refresh HMR
// cleanliness + unambiguous barrel re-exports.
// ---------------------------------------------------------------------------

import type { ReactNode } from 'react';

import { useScopeGate } from './useScopeGate';

export interface ScopeGateProps {
  /**
   * The action string to gate on — the compact `resource:ops` form (e.g.
   * `'users:r'`) unions ops across every unqualified matching grant; any
   * other shape matches only verbatim. Wildcard `*` grants all.
   */
  readonly action: string;
  /** Rendered when the gate denies access. Defaults to nothing. */
  readonly fallback?: ReactNode;
  /** Rendered when the gate allows access. */
  readonly children: ReactNode;
}

export function ScopeGate({
  action,
  fallback = null,
  children,
}: ScopeGateProps): React.JSX.Element {
  const gate = useScopeGate();
  if (gate.loading) return <>{null}</>;
  return <>{gate.can(action) ? children : fallback}</>;
}
