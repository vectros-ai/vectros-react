// ---------------------------------------------------------------------------
// <ScopeGate> tests — the fail-closed UI authorization wrapper.
//
// ScopeGate is the declarative gate around useScopeGate: it hides gated
// surface while scope resolves (loading → render nothing) and renders
// `children` only when `can(action)` is true, else `fallback`. Its only
// in-repo consumer (AppLayout) STUBS it out in its own tests, so the real
// loading/deny/allow branches are asserted here.
//
// We mock the co-located useScopeGate hook so each test drives a specific
// gate state (loading / deny / allow) deterministically — the hook's own
// token-decode logic is covered by its consumers' suites.
// ---------------------------------------------------------------------------

import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ScopeGate } from './ScopeGate';
import type { ScopeGateValue } from './useScopeGate';

const mockUseScopeGate = vi.hoisted(() => vi.fn<() => ScopeGateValue>());
vi.mock('./useScopeGate', () => ({
  useScopeGate: mockUseScopeGate,
}));

afterEach(() => {
  vi.clearAllMocks();
});

function Allow() {
  return <div data-testid="allow">privileged surface</div>;
}
function Deny() {
  return <div data-testid="deny">access denied</div>;
}

describe('<ScopeGate>', () => {
  it('renders NEITHER children nor fallback while the gate is loading (no flash-of-privileged-surface)', () => {
    mockUseScopeGate.mockReturnValue({
      loading: true,
      allowedActions: [],
      can: () => false,
    });

    render(
      <ScopeGate action="admin:users" fallback={<Deny />}>
        <Allow />
      </ScopeGate>,
    );

    // Loading must render nothing — not the children, and NOT the fallback
    // (the fallback is the deny state, not the loading state).
    expect(screen.queryByTestId('allow')).not.toBeInTheDocument();
    expect(screen.queryByTestId('deny')).not.toBeInTheDocument();
  });

  it('renders the fallback (not children) when the gate denies the action', () => {
    mockUseScopeGate.mockReturnValue({
      loading: false,
      allowedActions: [],
      can: () => false,
    });

    render(
      <ScopeGate action="admin:users" fallback={<Deny />}>
        <Allow />
      </ScopeGate>,
    );

    expect(screen.getByTestId('deny')).toBeInTheDocument();
    expect(screen.queryByTestId('allow')).not.toBeInTheDocument();
  });

  it('renders children when the gate allows the action', () => {
    mockUseScopeGate.mockReturnValue({
      loading: false,
      allowedActions: ['admin:users'],
      can: (a) => a === 'admin:users',
    });

    render(
      <ScopeGate action="admin:users" fallback={<Deny />}>
        <Allow />
      </ScopeGate>,
    );

    expect(screen.getByTestId('allow')).toBeInTheDocument();
    expect(screen.queryByTestId('deny')).not.toBeInTheDocument();
  });

  it('passes the exact action string through to can() (no widening)', () => {
    const can = vi.fn((a: string) => a === 'admin:keys');
    mockUseScopeGate.mockReturnValue({ loading: false, allowedActions: ['admin:keys'], can });

    render(
      <ScopeGate action="admin:keys">
        <Allow />
      </ScopeGate>,
    );

    expect(can).toHaveBeenCalledWith('admin:keys');
    expect(screen.getByTestId('allow')).toBeInTheDocument();
  });

  it('defaults the deny fallback to nothing when the prop is omitted', () => {
    mockUseScopeGate.mockReturnValue({
      loading: false,
      allowedActions: [],
      can: () => false,
    });

    const { container } = render(
      <ScopeGate action="admin:users">
        <Allow />
      </ScopeGate>,
    );

    // No fallback prop + deny → renders nothing at all.
    expect(screen.queryByTestId('allow')).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });
});
