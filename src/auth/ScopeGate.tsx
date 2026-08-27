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
import type { TenantId } from './types';

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
  /**
   * Forwarded to `useScopeGate` as its own `tenantOverride`. Omit in a
   * multi-tenant host (the common case) — the gate reads the active tenant
   * from `useCurrentTenant()`. A single-tenant host with no
   * `CurrentTenantProvider` in its tree MUST supply this: `useCurrentTenant()`
   * falls back to `tenant: null` with no provider, which leaves the
   * underlying `useScopeGate()` call permanently `loading` (its mint effect
   * never fires for a null tenant) — so this gate would hide `children`
   * forever, not just until the token resolves. Pass a stable, app-wide
   * constant (any non-empty string; a single-tenant exchange-based provider
   * ignores the value itself, see `Auth0AuthProvider.mintPartnerApiToken`).
   */
  readonly tenantOverride?: TenantId;
}

export function ScopeGate({
  action,
  fallback = null,
  children,
  tenantOverride,
}: ScopeGateProps): React.JSX.Element {
  const gate = useScopeGate(tenantOverride);
  if (gate.loading) return <>{null}</>;
  return <>{gate.can(action) ? children : fallback}</>;
}
