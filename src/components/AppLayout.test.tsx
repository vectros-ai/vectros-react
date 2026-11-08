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
import { createTheme, ThemeProvider } from '@mui/material';
import type { Theme } from '@mui/material';

import { AuthProvider, CurrentTenantProvider, useScopeGate } from '../auth';
import type { AuthUser, TenantMembership } from '../auth';
import { makeMockAuthProvider as mockAdapter } from '../test/mockAuthProvider';
import type { FullMockProvider } from '../test/mockAuthProvider';
import { AppLayout } from './AppLayout';
import type { NavItemSpec } from './AppLayout';
import { TestIntlProvider } from '../test/intl';

// The shell is brand-agnostic (brandName is a prop) and switcher-agnostic (the
// host passes a node); tests use a literal brand + a stub switcher node.
const BRAND_NAME = 'Vectros Admin';

// Mirrors the admin-app nav passed to the shared AppLayout in App.tsx — real
// grantable `resource:ops` verbs, not the retired `admin:<resource>` spelling
// (which no stored scope can ever carry; see useScopeGate's own tests for why).
const NAV_ITEMS: ReadonlyArray<NavItemSpec> = [
  { to: '/', labelId: 'layout.navWelcome', gateAction: null },
  { to: '/members', labelId: 'layout.navMembers', gateAction: 'users:r' },
  { to: '/keys', labelId: 'layout.navKeys', gateAction: 'keys:r' },
  { to: '/logs', labelId: 'layout.navLogs', gateAction: 'logs:r' },
];

// AppLayout gates nav via the <ScopeGate> component, which calls useScopeGate
// internally — both from this package's own auth module. Co-located here, the
// test mocks '../auth' directly: replace useScopeGate with a controllable
// vi.fn() and stub ScopeGate to render children based on that same hook (the
// real gate logic is covered by useScopeGate/ScopeGate's own suites). Each test
// sets the hook's return to model effective scope (wildcard OWNER vs empty).
const mockUseScopeGate = vi.hoisted(() => vi.fn());
// Captures the tenantOverride each gated nav item's <ScopeGate> was rendered
// with, so the "scopeGateTenant threads through" test can assert on it
// without a real useScopeGate() mint-effect round trip.
const scopeGateTenantOverrides = vi.hoisted((): string[] => []);
vi.mock('../auth', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- vitest's importOriginal idiom
  const actual = await importOriginal<typeof import('../auth')>();
  const ScopeGate = ({
    action,
    children,
    tenantOverride,
  }: {
    action?: string;
    children: ReactNode;
    tenantOverride?: string;
  }): ReactNode => {
    scopeGateTenantOverrides.push(tenantOverride ?? '');
    return (mockUseScopeGate() as { can: (a?: string) => boolean }).can(action) ? children : null;
  };
  return { ...actual, useScopeGate: mockUseScopeGate, ScopeGate };
});

const wildcardGate = {
  loading: false,
  allowedActions: ['*'] as ReadonlyArray<string>,
  identity: {} as Readonly<Record<string, string>>,
  can: () => true,
};

const noScopeGate = {
  loading: false,
  allowedActions: [] as ReadonlyArray<string>,
  identity: {} as Readonly<Record<string, string>>,
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

const aliceUser: AuthUser = {
  sub: 'sub-1',
  email: 'alice@example.com',
  firstName: 'Alice',
  lastName: 'Smith',
};

function renderLayout(
  provider: FullMockProvider,
  initialPath = '/',
  extraProps: {
    brandLogoSrc?: string;
    brandQualifier?: string;
    scopeGateTenant?: string;
    appBarStart?: ReactNode;
    appBarDense?: boolean;
    theme?: Theme;
  } = {},
) {
  const { theme, ...layoutProps } = extraProps;
  const withTheme = (children: ReactNode): ReactNode =>
    theme ? <ThemeProvider theme={theme}>{children}</ThemeProvider> : children;
  return render(
    withTheme(
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
                      {...layoutProps}
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
    ),
  );
}

afterEach(() => {
  vi.clearAllMocks();
  scopeGateTenantOverrides.length = 0;
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

    it('forwards scopeGateTenant to every gated nav item\'s <ScopeGate> — the single-tenant-host escape hatch', async () => {
      vi.mocked(useScopeGate).mockReturnValue(wildcardGate);
      const provider = mockAdapter({
        getCurrentUser: vi.fn().mockResolvedValue(aliceUser),
      });
      renderLayout(provider, '/', { scopeGateTenant: 'exchange-resolved' });

      await waitFor(() => {
        expect(screen.queryAllByRole('link', { name: /members/i }).length).toBeGreaterThan(0);
      });
      // Every gated item (Members/Keys/Logs, rendered in both the permanent
      // and mobile Drawers) got the same override — never an empty/omitted
      // value while the prop was supplied.
      expect(scopeGateTenantOverrides.length).toBeGreaterThan(0);
      expect(scopeGateTenantOverrides.every((t) => t === 'exchange-resolved')).toBe(true);
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

  describe('top bar', () => {
    // The MUI Toolbar is the single child of the AppBar's <header>. Its direct
    // children are the bar's slots, in render order.
    const getToolbar = (): HTMLElement => {
      const toolbar = screen.getByRole('banner').firstElementChild;
      if (!(toolbar instanceof HTMLElement)) throw new Error('top bar toolbar not found');
      return toolbar;
    };

    const follows = (earlier: Element, later: Element): boolean =>
      Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);

    describe('default (neither appBarStart nor appBarDense)', () => {
      // The tests above that already pin the default bar: 'opens the user menu
      // with correct ARIA wiring…' and 'hides the user menu trigger when no user
      // is loaded' (account menu), and the 'switcher slot' pair (switcher shown
      // when signed in, hidden when signed out).
      // These add what those do not assert: the bar's height variant and its
      // exact set of slots.
      it('uses the regular toolbar with only the menu button, spacer, switcher and account menu', async () => {
        const provider = mockAdapter({ getCurrentUser: vi.fn().mockResolvedValue(aliceUser) });
        renderLayout(provider);
        await screen.findByLabelText('Open user menu');

        const toolbar = getToolbar();
        expect(toolbar).toHaveClass('MuiToolbar-regular');
        expect(toolbar).not.toHaveClass('MuiToolbar-dense');
        expect(toolbar.children).toHaveLength(4);
        expect(toolbar.children[0]).toBe(screen.getByLabelText('Open navigation'));
        expect(toolbar.children[1]).toHaveStyle({ flexGrow: '1' });
        expect(toolbar.children[2]).toContainElement(screen.getByTestId('switcher-slot'));
        expect(toolbar.children[3]).toBe(screen.getByLabelText('Open user menu'));
      });

      it('leaves a host theme that makes toolbars dense by default in charge of the bar height', async () => {
        const theme = createTheme({ components: { MuiToolbar: { defaultProps: { variant: 'dense' } } } });
        const provider = mockAdapter({ getCurrentUser: vi.fn().mockResolvedValue(aliceUser) });
        renderLayout(provider, '/', { theme });
        await screen.findByLabelText('Open user menu');
        expect(getToolbar()).toHaveClass('MuiToolbar-dense');
      });

      it('keeps the sidebar brand header at 64px', async () => {
        const provider = mockAdapter({ getCurrentUser: vi.fn().mockResolvedValue(aliceUser) });
        renderLayout(provider);
        await screen.findByLabelText('Open user menu');
        for (const link of screen.getAllByRole('link', { name: BRAND_NAME })) {
          expect(link).toHaveStyle({ minHeight: '64px', paddingTop: '16px', paddingBottom: '16px' });
        }
      });

      it('keeps the vertical padding around the page content', async () => {
        const provider = mockAdapter({ getCurrentUser: vi.fn().mockResolvedValue(aliceUser) });
        renderLayout(provider);
        await screen.findByText('welcome content');
        const container = screen.getByRole('main').firstElementChild as HTMLElement;
        expect(container).toHaveStyle({ paddingTop: '32px', paddingBottom: '32px' });
      });
    });

    describe('appBarStart', () => {
      it.each([['null', null], ['false', false]])('adds nothing to the bar when %s', async (_name, appBarStart) => {
        const provider = mockAdapter({ getCurrentUser: vi.fn().mockResolvedValue(aliceUser) });
        renderLayout(provider, '/', { appBarStart });
        await screen.findByLabelText('Open user menu');
        expect(getToolbar().children).toHaveLength(4);
      });

      it('renders the node between the menu button and the flexible spacer', async () => {
        const provider = mockAdapter({ getCurrentUser: vi.fn().mockResolvedValue(aliceUser) });
        renderLayout(provider, '/', {
          appBarStart: <span data-testid="start-slot">Acme Console</span>,
        });
        const start = await screen.findByTestId('start-slot');

        const toolbar = getToolbar();
        expect(toolbar.children).toHaveLength(5);
        expect(toolbar.children[0]).toBe(screen.getByLabelText('Open navigation'));
        expect(toolbar.children[1]).toContainElement(start);
        // minWidth 0 is what lets a long truncating title shrink instead of
        // pushing the account menu off the bar (jsdom has no layout to measure).
        expect(toolbar.children[1]).toHaveStyle({ minWidth: '0px' });
        // Trailing space keeps a truncated title from touching the controls
        // to its right.
        expect(toolbar.children[1]).toHaveStyle({ marginRight: '16px' });
        // The spacer follows the start slot; it is what pushes the switcher and
        // account menu to the right.
        expect(toolbar.children[2]).toHaveStyle({ flexGrow: '1' });
        expect(follows(start, screen.getByTestId('switcher-slot'))).toBe(true);
        expect(follows(start, screen.getByLabelText('Open user menu'))).toBe(true);
      });

      it('renders for a signed-out user while the switcher and account menu stay hidden', async () => {
        const provider = mockAdapter({ getCurrentUser: vi.fn().mockResolvedValue(null) });
        renderLayout(provider, '/', {
          appBarStart: <span data-testid="start-slot">Acme Console</span>,
        });
        expect(await screen.findByTestId('start-slot')).toBeInTheDocument();
        expect(screen.queryByTestId('switcher-slot')).not.toBeInTheDocument();
        expect(screen.queryByLabelText('Open user menu')).not.toBeInTheDocument();
      });
    });

    describe('appBarDense', () => {
      it('switches the toolbar to the dense variant', async () => {
        const provider = mockAdapter({ getCurrentUser: vi.fn().mockResolvedValue(aliceUser) });
        renderLayout(provider, '/', { appBarDense: true });
        await screen.findByLabelText('Open user menu');

        const toolbar = getToolbar();
        expect(toolbar).toHaveClass('MuiToolbar-dense');
        expect(toolbar).not.toHaveClass('MuiToolbar-regular');
        expect(toolbar).toHaveStyle({ minHeight: '48px' });
      });

      it('shortens the sidebar brand header to match, so the two stay aligned', async () => {
        const provider = mockAdapter({ getCurrentUser: vi.fn().mockResolvedValue(aliceUser) });
        renderLayout(provider, '/', { appBarDense: true });
        await screen.findByLabelText('Open user menu');
        const links = screen.getAllByRole('link', { name: BRAND_NAME });
        expect(links.length).toBeGreaterThan(0);
        for (const link of links) {
          expect(link).toHaveStyle({ minHeight: '48px', paddingTop: '0px', paddingBottom: '0px' });
        }
      });

      it('keeps the regular toolbar when explicitly false', async () => {
        const provider = mockAdapter({ getCurrentUser: vi.fn().mockResolvedValue(aliceUser) });
        renderLayout(provider, '/', { appBarDense: false });
        await screen.findByLabelText('Open user menu');
        expect(getToolbar()).toHaveClass('MuiToolbar-regular');
      });

      it('changes only the bar height: slots and content padding are unchanged', async () => {
        const provider = mockAdapter({ getCurrentUser: vi.fn().mockResolvedValue(aliceUser) });
        renderLayout(provider, '/', { appBarDense: true });
        await screen.findByLabelText('Open user menu');

        expect(getToolbar().children).toHaveLength(4);
        expect(screen.getByTestId('switcher-slot')).toBeInTheDocument();
        const container = screen.getByRole('main').firstElementChild as HTMLElement;
        expect(container).toHaveStyle({ paddingTop: '32px', paddingBottom: '32px' });
      });

      it('combines with appBarStart', async () => {
        const provider = mockAdapter({ getCurrentUser: vi.fn().mockResolvedValue(aliceUser) });
        renderLayout(provider, '/', {
          appBarDense: true,
          appBarStart: <span data-testid="start-slot">Acme Console</span>,
        });
        await screen.findByTestId('start-slot');
        expect(getToolbar()).toHaveClass('MuiToolbar-dense');
        expect(getToolbar().children).toHaveLength(5);
      });
    });
  });
});
