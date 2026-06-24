// ---------------------------------------------------------------------------
// AppLayout tests.
//
// Verifies the visible-to-the-user contract: brand renders, user dropdown
// opens with correct ARIA state, email shows, sign-out triggers adapter +
// navigation. The skip-link a11y is also asserted.
// ---------------------------------------------------------------------------

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ReactNode } from 'react';

import { AuthProvider, CurrentTenantProvider, useScopeGate } from '../auth';
import type { AuthProviderAdapter, AuthUser, TenantMembership } from '../auth';
import { AppLayout } from './AppLayout';
import type { NavItemSpec } from './AppLayout';
import { TestIntlProvider } from '../test/intl';

// The shell is brand-agnostic (brandName is a prop) and switcher-agnostic (the
// host passes a node); tests use a literal brand + a stub switcher node.
const BRAND_NAME = 'Vectros Admin';

// Mirrors the admin-app nav passed to the shared AppLayout in App.tsx.
const NAV_ITEMS: ReadonlyArray<NavItemSpec> = [
  { to: '/', labelId: 'layout.navWelcome', gateAction: null },
  { to: '/members', labelId: 'layout.navMembers', gateAction: 'admin:users' },
  { to: '/keys', labelId: 'layout.navKeys', gateAction: 'admin:keys' },
  { to: '/logs', labelId: 'layout.navLogs', gateAction: 'admin:logs' },
];

// AppLayout gates nav via the <ScopeGate> component, which calls useScopeGate
// internally — both from this package's own auth module. Co-located here, the
// test mocks '../auth' directly: replace useScopeGate with a controllable
// vi.fn() and stub ScopeGate to render children based on that same hook (the
// real gate logic is covered by useScopeGate/ScopeGate's own suites). Each test
// sets the hook's return to model effective scope (wildcard OWNER vs empty).
const mockUseScopeGate = vi.hoisted(() => vi.fn());
vi.mock('../auth', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- vitest's importOriginal idiom
  const actual = await importOriginal<typeof import('../auth')>();
  const ScopeGate = ({ action, children }: { action?: string; children: ReactNode }): ReactNode =>
    (mockUseScopeGate() as { can: (a?: string) => boolean }).can(action) ? children : null;
  return { ...actual, useScopeGate: mockUseScopeGate, ScopeGate };
});

const wildcardGate = {
  loading: false,
  allowedActions: ['*'] as ReadonlyArray<string>,
  can: () => true,
};

const noScopeGate = {
  loading: false,
  allowedActions: [] as ReadonlyArray<string>,
  can: () => false,
};

// Two memberships so the TenantSwitcher renders (it auto-hides for <= 1).
const SWITCHER_MEMBERSHIPS: ReadonlyArray<TenantMembership> = [
  { tenantId: 'tnt_live', tenantName: 'Live', tenantKind: 'live', role: 'OWNER', status: 'ACTIVE', partnerId: 'p1' },
  { tenantId: 'tnt_test', tenantName: 'Test', tenantKind: 'test', role: 'OWNER', status: 'ACTIVE', partnerId: 'p1' },
];

beforeEach(() => {
  vi.mocked(useScopeGate).mockReturnValue(wildcardGate);
});

function mockAdapter(overrides: Partial<AuthProviderAdapter> = {}): AuthProviderAdapter {
  return {
    getCurrentUser: vi.fn().mockResolvedValue(null),
    signIn: vi.fn(),
    confirmSignIn: vi.fn(),
    signUp: vi.fn(),
    confirmSignUp: vi.fn(),
    resendSignUpCode: vi.fn(),
    forgotPassword: vi.fn(),
    confirmForgotPassword: vi.fn(),
    changePassword: vi.fn(),
    signOut: vi.fn().mockResolvedValue(undefined),
    getIdToken: vi.fn(),
    getMemberships: vi.fn().mockResolvedValue([]),
    getActiveTenant: vi.fn().mockResolvedValue(null),
    getActivePartnerUserId: vi.fn().mockResolvedValue(null),
    setActiveTenant: vi.fn().mockResolvedValue(undefined),
    checkUserExists: vi.fn().mockResolvedValue({ exists: false, isMe: false }),
    linkInvitation: vi.fn().mockResolvedValue({ tenantId: '', partnerUserId: '', role: 'SUB_USER', alreadyActive: false }),
    getMfaStatus: vi.fn().mockResolvedValue({ enabled: [], preferred: null }),
    setUpTotp: vi.fn().mockResolvedValue({ secret: 'MOCKSECRET234567', otpauthUri: 'otpauth://totp/Mock:me?secret=MOCKSECRET234567&issuer=Mock' }),
    verifyTotpSetup: vi.fn().mockResolvedValue(undefined),
    disableTotp: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const aliceUser: AuthUser = {
  sub: 'sub-1',
  email: 'alice@example.com',
  firstName: 'Alice',
  lastName: 'Smith',
};

function renderLayout(
  provider: AuthProviderAdapter,
  initialPath = '/',
  extraProps: { brandLogoSrc?: string; brandQualifier?: string } = {},
) {
  return render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        <AuthProvider provider={provider}>
          <CurrentTenantProvider initialTenant="tnt_test" initialMemberships={SWITCHER_MEMBERSHIPS}>
            <Routes>
              <Route
                element={
                  <AppLayout
                    brandName={BRAND_NAME}
                    navItems={NAV_ITEMS}
                    switcher={<div data-testid="switcher-slot">switcher</div>}
                    {...extraProps}
                  />
                }
              >
                <Route index element={<div>welcome content</div>} />
              </Route>
              <Route path="/login" element={<div>login page</div>} />
            </Routes>
          </CurrentTenantProvider>
        </AuthProvider>
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('AppLayout', () => {
  it('renders the brand product name in the sidebar (as non-heading text)', async () => {
    const provider = mockAdapter({
      getCurrentUser: vi.fn().mockResolvedValue(aliceUser),
    });
    renderLayout(provider);
    // The brand header lives in the sidebar, which jsdom renders for BOTH the
    // permanent (md+) and temporary (mobile) Drawers — so the name appears more
    // than once. Assert presence with queryAllByText, like the nav assertions.
    await waitFor(() => {
      expect(screen.queryAllByText(BRAND_NAME).length).toBeGreaterThan(0);
    });
    // Brand is rendered as a non-heading span — explicitly NOT a heading. Each
    // protected route's own h1 is the unambiguous page title.
    expect(
      screen.queryByRole('heading', { name: BRAND_NAME }),
    ).not.toBeInTheDocument();
  });

  it('renders the brand qualifier as a distinct sub-label when provided', async () => {
    const provider = mockAdapter({
      getCurrentUser: vi.fn().mockResolvedValue(aliceUser),
    });
    renderLayout(provider, '/', { brandQualifier: 'Admin' });
    // Appears in the sidebar (both Drawers in jsdom) alongside the brand mark,
    // and — like the brand name — is deliberately NOT a heading.
    await waitFor(() => {
      expect(screen.queryAllByText('Admin').length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole('heading', { name: 'Admin' })).not.toBeInTheDocument();
  });

  it('renders no qualifier when none is provided', async () => {
    const provider = mockAdapter({
      getCurrentUser: vi.fn().mockResolvedValue(aliceUser),
    });
    renderLayout(provider);
    await waitFor(() => {
      expect(screen.queryAllByText(BRAND_NAME).length).toBeGreaterThan(0);
    });
    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
  });

  it('renders the outlet content', async () => {
    const provider = mockAdapter({
      getCurrentUser: vi.fn().mockResolvedValue(aliceUser),
    });
    renderLayout(provider);
    await waitFor(() => {
      expect(screen.getByText('welcome content')).toBeInTheDocument();
    });
  });

  it('renders a skip-to-content link targeting the main region', async () => {
    const provider = mockAdapter({
      getCurrentUser: vi.fn().mockResolvedValue(aliceUser),
    });
    renderLayout(provider);
    await waitFor(() => {
      const link = screen.getByText('Skip to main content');
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute('href', '#main-content');
    });
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
  });

  it('hides the user menu trigger when no user is loaded', async () => {
    const provider = mockAdapter({
      getCurrentUser: vi.fn().mockResolvedValue(null),
    });
    renderLayout(provider);
    // Wait for AppLayout to mount, then assert absence of user menu.
    // (Brand renders in the sidebar — present even with no user — and across
    // both Drawers, so match with queryAllByText.)
    await waitFor(() => {
      expect(screen.queryAllByText(BRAND_NAME).length).toBeGreaterThan(0);
    });
    expect(screen.queryByLabelText('Open user menu')).not.toBeInTheDocument();
  });

  it('opens the user menu with correct ARIA wiring and shows the email', async () => {
    const user = userEvent.setup();
    const provider = mockAdapter({
      getCurrentUser: vi.fn().mockResolvedValue(aliceUser),
    });
    renderLayout(provider);
    const trigger = await screen.findByLabelText('Open user menu');
    expect(trigger).toHaveAttribute('aria-haspopup', 'true');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    // aria-controls now references the React 19 useId()-generated value
    // (was hardcoded 'user-menu' pre-Step-3). Assert ARIA wiring shape:
    // attribute is present, non-empty, AND no longer the stale literal
    // 'user-menu' that would shadow a second instance of the layout.
    const ariaControls = trigger.getAttribute('aria-controls');
    expect(ariaControls).toBeTruthy();
    expect(ariaControls).not.toBe('user-menu');
    // The id must resolve to an actual element in the rendered tree — the
    // popover root that contains the menu. (MUI v7's <Menu id=…/> applies
    // the id to the Paper wrapper, not the inner role="menu" ul.)
    expect(document.getElementById(ariaControls!)).not.toBeNull();
    expect(screen.getByText('Signed in as')).toBeInTheDocument();
    // The display name is shown above the email when the session carries one.
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('shows only the email in the menu when the session carries no name', async () => {
    const user = userEvent.setup();
    const provider = mockAdapter({
      getCurrentUser: vi.fn().mockResolvedValue({ sub: 'sub-2', email: 'noname@example.com' }),
    });
    renderLayout(provider);
    await user.click(await screen.findByLabelText('Open user menu'));

    expect(screen.getByText('noname@example.com')).toBeInTheDocument();
    // No name line — only the "Signed in as" eyebrow + the email.
    expect(screen.queryByText('Alice Smith')).not.toBeInTheDocument();
  });

  it('signs out and navigates to /login when the Sign out menu item is clicked', async () => {
    const user = userEvent.setup();
    const signOutSpy = vi.fn().mockResolvedValue(undefined);
    const provider = mockAdapter({
      getCurrentUser: vi.fn().mockResolvedValue(aliceUser),
      signOut: signOutSpy,
    });
    renderLayout(provider);

    await user.click(await screen.findByLabelText('Open user menu'));
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));

    await waitFor(() => {
      expect(signOutSpy).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByText('login page')).toBeInTheDocument();
    });
  });

  describe('sidebar nav', () => {
    it('renders all nav items for a wildcard-scope user (Dev Admin)', async () => {
      vi.mocked(useScopeGate).mockReturnValue(wildcardGate);
      const provider = mockAdapter({
        getCurrentUser: vi.fn().mockResolvedValue(aliceUser),
      });
      renderLayout(provider);

      // Welcome is always visible (no gate). Members/Keys/Logs are gated.
      // Use findAllByRole to allow the permanent + mobile drawers to both
      // render their nav lists in jsdom (xs + md sx queries are evaluated
      // structurally; both Drawers can be in the DOM tree).
      await waitFor(() => {
        expect(screen.queryAllByRole('link', { name: /welcome/i }).length).toBeGreaterThan(0);
      });
      expect(screen.queryAllByRole('link', { name: /members/i }).length).toBeGreaterThan(0);
      expect(screen.queryAllByRole('link', { name: /scoped keys/i }).length).toBeGreaterThan(0);
      expect(screen.queryAllByRole('link', { name: /^logs$/i }).length).toBeGreaterThan(0);
    });

    it('hides Members / Keys / Logs for a no-scope user (sub-user without admin actions)', async () => {
      vi.mocked(useScopeGate).mockReturnValue(noScopeGate);
      const provider = mockAdapter({
        getCurrentUser: vi.fn().mockResolvedValue(aliceUser),
      });
      renderLayout(provider);

      await waitFor(() => {
        expect(screen.queryAllByRole('link', { name: /welcome/i }).length).toBeGreaterThan(0);
      });
      expect(screen.queryByRole('link', { name: /members/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /scoped keys/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /^logs$/i })).not.toBeInTheDocument();
    });
  });

  describe('switcher slot', () => {
    it('renders the app-provided switcher node in the AppBar when signed in', async () => {
      const provider = mockAdapter({
        getCurrentUser: vi.fn().mockResolvedValue(aliceUser),
      });
      renderLayout(provider);
      // AppLayout renders whatever switcher node the host passes (admin's
      // TenantSwitcher, app.vectros.ai's ContextSwitcher, …) — here a stub.
      expect(await screen.findByTestId('switcher-slot')).toBeInTheDocument();
    });

    it('hides the switcher slot when no user is loaded', async () => {
      const provider = mockAdapter({ getCurrentUser: vi.fn().mockResolvedValue(null) });
      renderLayout(provider);
      await waitFor(() => {
        expect(screen.queryAllByText(BRAND_NAME).length).toBeGreaterThan(0);
      });
      expect(screen.queryByTestId('switcher-slot')).not.toBeInTheDocument();
    });
  });
});
