// ---------------------------------------------------------------------------
// <RequireScope> tests — the route-level scope gate.
//
// Mirrors ScopeGate.test.tsx's approach: mock the co-located useScopeGate hook
// so each test drives a specific gate state (loading / deny / allow)
// deterministically, rather than threading a real token through.
// ---------------------------------------------------------------------------

import { MemoryRouter, Route, Routes } from 'react-router';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RequireScope } from './RequireScope';
import type { ScopeGateValue } from '../auth/useScopeGate';

const mockUseScopeGate = vi.hoisted(() => vi.fn<(tenantOverride?: string) => ScopeGateValue>());
vi.mock('../auth/useScopeGate', () => ({
  useScopeGate: mockUseScopeGate,
}));

afterEach(() => {
  vi.clearAllMocks();
});

function Protected() {
  return <div data-testid="protected">privileged route content</div>;
}

function renderAt(initialPath: string, element: React.ReactElement) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/protected" element={element} />
        <Route path="/" element={<div data-testid="fallback-home">home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('<RequireScope>', () => {
  it('renders nothing while the gate is loading (no flash-of-redirect)', () => {
    mockUseScopeGate.mockReturnValue({
      loading: true,
      allowedActions: [],
      identity: {},
      can: () => false,
    });

    renderAt(
      '/protected',
      <RequireScope action="entities:c:org">
        <Protected />
      </RequireScope>,
    );

    expect(screen.queryByTestId('protected')).not.toBeInTheDocument();
    expect(screen.queryByTestId('fallback-home')).not.toBeInTheDocument();
  });

  it('redirects to the default "/" when the gate denies the action', () => {
    mockUseScopeGate.mockReturnValue({
      loading: false,
      allowedActions: [],
      identity: {},
      can: () => false,
    });

    renderAt(
      '/protected',
      <RequireScope action="entities:c:org">
        <Protected />
      </RequireScope>,
    );

    expect(screen.queryByTestId('protected')).not.toBeInTheDocument();
    expect(screen.getByTestId('fallback-home')).toBeInTheDocument();
  });

  it('redirects to a custom redirectTo when supplied', () => {
    mockUseScopeGate.mockReturnValue({
      loading: false,
      allowedActions: [],
      identity: {},
      can: () => false,
    });

    render(
      <MemoryRouter initialEntries={['/protected']}>
        <Routes>
          <Route
            path="/protected"
            element={
              <RequireScope action="entities:c:org" redirectTo="/cases">
                <Protected />
              </RequireScope>
            }
          />
          <Route path="/cases" element={<div data-testid="cases-fallback">cases</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByTestId('cases-fallback')).toBeInTheDocument();
  });

  it('renders children when the gate allows the action', () => {
    mockUseScopeGate.mockReturnValue({
      loading: false,
      allowedActions: ['entities:c:org'],
      identity: {},
      can: (a) => a === 'entities:c:org',
    });

    renderAt(
      '/protected',
      <RequireScope action="entities:c:org">
        <Protected />
      </RequireScope>,
    );

    expect(screen.getByTestId('protected')).toBeInTheDocument();
    expect(screen.queryByTestId('fallback-home')).not.toBeInTheDocument();
  });

  it('forwards tenantOverride through to useScopeGate — the single-tenant-host escape hatch', () => {
    mockUseScopeGate.mockReturnValue({
      loading: false,
      allowedActions: ['entities:c:org'],
      identity: {},
      can: (a) => a === 'entities:c:org',
    });

    renderAt(
      '/protected',
      <RequireScope action="entities:c:org" tenantOverride="exchange-resolved">
        <Protected />
      </RequireScope>,
    );

    expect(mockUseScopeGate).toHaveBeenCalledWith('exchange-resolved');
    expect(screen.getByTestId('protected')).toBeInTheDocument();
  });
});
