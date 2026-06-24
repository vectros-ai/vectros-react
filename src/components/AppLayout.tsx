// ---------------------------------------------------------------------------
// AppLayout — the authenticated app shell (shared across Vectros reference apps).
//
// Structure (a dark nav rail + a light content column):
//   - Skip-to-content link (visible only on keyboard focus, WCAG 2.4.1).
//   - Dark sidebar Drawer (permanent on desktop, temporary overlay on mobile):
//     - Brand header (logo image if the host provides one, else the product
//       name as text) linking home.
//     - App-provided nav items, each with an optional leading icon; every gated
//       item is wrapped in <ScopeGate> so a principal without the action never
//       sees the nav surface.
//   - Light top AppBar in the content column: mobile menu button, an
//     app-provided switcher slot, and the user-account menu.
//   - Main content area (Outlet renders the nested route's component).
//
// The shell is brand- and app-agnostic:
//   - `brandName`     — the product label (logo alt text / text fallback).
//   - `brandLogoSrc`  — optional logo image URL; falls back to `brandName` text.
//   - `navItems`      — the host app's nav (admin: Members/Keys/Logs;
//                       app.vectros.ai: Records/Documents/Search; …). Labels are
//                       i18n message ids; each item may carry a leading icon.
//   - `switcher`      — an app-provided node rendered in the AppBar when signed in
//                       (admin's TenantSwitcher; app.vectros.ai's ContextSwitcher).
//
// The sidebar is a fixed near-black surface with light-on-dark foreground —
// the canonical backdrop for a light brand mark. Surface/divider colors
// elsewhere come from the theme, not a brand import.
//
// Sign-out flow: useAuth().signOut() → navigate('/login', { replace }). The
// user menu also links to /account. Both routes are conventions the host app
// wires.
// ---------------------------------------------------------------------------

import { useId, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { FormattedMessage, useIntl } from 'react-intl';
// Deep-import the single icon we use rather than the barrel `from
// '@mui/icons-material'`. MUI v7's icons package ships thousands of files and
// jsdom-based test environments (Vitest) hit EMFILE on Windows when the barrel
// is resolved. Deep imports also tree-shake more reliably in production builds.
import MenuIcon from '@mui/icons-material/Menu';
import {
  AppBar,
  Avatar,
  Box,
  CircularProgress,
  Container,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Toolbar,
  Typography,
} from '@mui/material';

import { useAuth } from '../auth';
import { useCurrentTenant } from '../auth';
import { ScopeGate } from '../auth';

const DRAWER_WIDTH = 220;

// Fixed near-black rail with translucent-white foreground overlays — the
// active/hover states read consistently against it without a second brand color.
const RAIL_BG = '#09090B';
const RAIL_TEXT = 'rgba(255, 255, 255, 0.72)';
const RAIL_HOVER_BG = 'rgba(255, 255, 255, 0.08)';
const RAIL_ACTIVE_BG = 'rgba(255, 255, 255, 0.14)';
const RAIL_DIVIDER = 'rgba(255, 255, 255, 0.12)';

/** A single sidebar nav entry. `labelId` is an i18n message id the host app's
 *  catalog defines; `gateAction` null = always visible, else gated via ScopeGate;
 *  `icon` is an optional leading icon node (decorative — the label names the link). */
export interface NavItemSpec {
  readonly to: string;
  readonly labelId: string;
  readonly gateAction: string | null;
  readonly icon?: ReactNode;
}

interface NavListProps {
  readonly navItems: ReadonlyArray<NavItemSpec>;
  /** Called when a nav item is selected. Used by the mobile Drawer to close. */
  readonly onItemSelect?: () => void;
}

/** Vertical nav list rendered inside the sidebar Drawer. */
function NavList({ navItems, onItemSelect }: NavListProps): React.JSX.Element {
  const intl = useIntl();
  return (
    // `component="nav"` makes this a navigation landmark (a11y); the aria-label
    // names it for screen readers and lets tests target the nav directly.
    <List
      component="nav"
      aria-label={intl.formatMessage({ id: 'layout.primaryNav' })}
      sx={{ px: 1, pt: 1 }}
    >
      {navItems.map((item) => {
        const link = (
          <ListItem key={item.to} disablePadding>
            <ListItemButton
              component={NavLink}
              to={item.to}
              end={item.to === '/'}
              onClick={onItemSelect}
              sx={{
                borderRadius: 1,
                mb: 0.5,
                color: RAIL_TEXT,
                '& .MuiListItemIcon-root': { color: 'inherit', minWidth: 36 },
                '&:hover': { backgroundColor: RAIL_HOVER_BG, color: 'common.white' },
                '&.active': {
                  backgroundColor: RAIL_ACTIVE_BG,
                  color: 'common.white',
                  fontWeight: 700,
                },
              }}
            >
              {item.icon != null && <ListItemIcon>{item.icon}</ListItemIcon>}
              <ListItemText
                primary={<FormattedMessage id={item.labelId} />}
                primaryTypographyProps={{ fontSize: 14, fontWeight: 'inherit' }}
              />
            </ListItemButton>
          </ListItem>
        );
        if (item.gateAction === null) return link;
        return (
          <ScopeGate key={item.to} action={item.gateAction}>
            {link}
          </ScopeGate>
        );
      })}
    </List>
  );
}

interface SidebarHeaderProps {
  readonly brandName: string;
  readonly brandLogoSrc?: string;
  readonly brandQualifier?: string;
}

/** Brand header at the top of the sidebar — logo image if provided, else the
 *  product name as text. Links home. Rendered as a non-heading so each routed
 *  page's own h1 stays the unambiguous page title (a WCAG anti-pattern to compete
 *  with).
 *
 *  `brandQualifier` names the specific app behind a shared brand mark (e.g. the
 *  admin console vs the data app, both branded "Vectros"). It's rendered in a
 *  deliberately distinct, quieter style — a thin divider + lighter-weight,
 *  letter-spaced, muted label — so it reads as a sub-label of the wordmark, not
 *  part of it. Omit it for single-app brands. */
function SidebarHeader({
  brandName,
  brandLogoSrc,
  brandQualifier,
}: SidebarHeaderProps): React.JSX.Element {
  return (
    <Box
      component={NavLink}
      to="/"
      sx={{
        display: 'flex',
        alignItems: 'center',
        minHeight: 64,
        px: 2.5,
        py: 2,
        textDecoration: 'none',
        color: 'inherit',
      }}
    >
      {brandLogoSrc ? (
        <Box component="img" src={brandLogoSrc} alt={brandName} sx={{ height: 26, display: 'block' }} />
      ) : (
        <Typography
          variant="h6"
          component="span"
          sx={{ fontWeight: 800, letterSpacing: '-0.02em', color: 'common.white' }}
        >
          {brandName}
        </Typography>
      )}
      {brandQualifier && (
        <>
          <Box
            aria-hidden
            // Asymmetric margins: the wordmark SVG carries trailing whitespace, so
            // a tighter LEFT margin + roomier RIGHT one lands the divider visually
            // equidistant between the mark and the qualifier.
            sx={{ width: '1px', alignSelf: 'stretch', my: 1.25, ml: 0.25, mr: 1, bgcolor: 'rgba(255, 255, 255, 0.2)' }}
          />
          <Typography
            component="span"
            sx={{
              fontSize: 13,
              fontWeight: 500,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: 'rgba(255, 255, 255, 0.6)',
            }}
          >
            {brandQualifier}
          </Typography>
        </>
      )}
    </Box>
  );
}

export interface AppLayoutProps {
  /** Product label — logo alt text and the text fallback when no logo is given. */
  readonly brandName: string;
  /** Optional logo image URL shown in the sidebar header (falls back to brandName text). */
  readonly brandLogoSrc?: string;
  /** Optional app sub-label next to the brand mark — names the specific app behind
   *  a shared brand (e.g. "Admin" vs "Data"). Rendered in a quieter, distinct style. */
  readonly brandQualifier?: string;
  /** The host app's sidebar nav. */
  readonly navItems: ReadonlyArray<NavItemSpec>;
  /** Optional AppBar node rendered when signed in (a tenant/context switcher). */
  readonly switcher?: ReactNode;
}

export function AppLayout({
  brandName,
  brandLogoSrc,
  brandQualifier,
  navItems,
  switcher,
}: AppLayoutProps): React.JSX.Element {
  const { user, signOut } = useAuth();
  // Tenant gate: while memberships + active tenant load, the routed page
  // (Outlet) shows a spinner so tenant-scoped pages never render without a
  // tenant. Gated on `loading` only — NOT on success — so the identity-level
  // landing page stays resilient if the memberships read fails.
  const { loading: tenantLoading } = useCurrentTenant();
  const navigate = useNavigate();
  const intl = useIntl();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  // useId() over a hardcoded id — collision-safe if the same component appears
  // more than once on a page.
  const userMenuId = useId();

  const userMenuLabel = intl.formatMessage({ id: 'layout.userMenuLabel' });

  const handleMenuOpen = (event: MouseEvent<HTMLElement>): void => {
    setMenuAnchor(event.currentTarget);
  };
  const handleMenuClose = (): void => {
    setMenuAnchor(null);
  };

  const handleSignOut = async (): Promise<void> => {
    handleMenuClose();
    await signOut();
    navigate('/login', { replace: true });
  };

  const handleAccount = (): void => {
    handleMenuClose();
    navigate('/account');
  };

  const handleMobileDrawerToggle = (): void => {
    setMobileDrawerOpen((open) => !open);
  };

  const handleMobileNavItemSelect = (): void => {
    setMobileDrawerOpen(false);
  };

  const menuOpen = menuAnchor !== null;

  // First initial for the account avatar — name when known, else the email.
  const avatarInitial = (user?.firstName?.[0] ?? user?.email?.[0] ?? '?').toUpperCase();

  // Display name for the account menu (shown above the email). Empty when the
  // session carries no name — then the email stands alone as the identity.
  const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(' ');

  // Dark-rail paper shared by the permanent + temporary Drawers.
  const railPaperSx = {
    width: DRAWER_WIDTH,
    boxSizing: 'border-box' as const,
    backgroundColor: RAIL_BG,
    color: 'common.white',
    borderRight: 'none',
  };

  const railContent = (onItemSelect?: () => void): React.JSX.Element => (
    <>
      <SidebarHeader
        brandName={brandName}
        {...(brandLogoSrc ? { brandLogoSrc } : {})}
        {...(brandQualifier ? { brandQualifier } : {})}
      />
      <Divider sx={{ borderColor: RAIL_DIVIDER }} />
      <NavList navItems={navItems} {...(onItemSelect ? { onItemSelect } : {})} />
    </>
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', backgroundColor: 'background.default' }}>
      {/*
        Skip link — hidden off-screen until it receives keyboard focus, at which
        point it jumps to the upper-left corner so a screen-reader or keyboard-only
        user can bypass the nav and land in main content.
      */}
      <Box
        component="a"
        href="#main-content"
        sx={{
          // Modern visually-hidden pattern — collapsed to a clipped 1px box until
          // focused, then revealed top-left.
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clipPath: 'inset(50%)',
          whiteSpace: 'nowrap',
          textDecoration: 'none',
          '&:focus': {
            left: 8,
            top: 8,
            width: 'auto',
            height: 'auto',
            overflow: 'visible',
            clipPath: 'none',
            zIndex: (t) => t.zIndex.tooltip + 1,
            backgroundColor: 'background.paper',
            color: 'text.primary',
            padding: 1,
            borderRadius: 1,
            border: '1px solid',
            borderColor: 'divider',
          },
        }}
      >
        <FormattedMessage id="layout.skipToContent" />
      </Box>

      {/* Permanent dark sidebar on desktop (md+). */}
      <Drawer
        variant="permanent"
        sx={{
          width: DRAWER_WIDTH,
          flexShrink: 0,
          display: { xs: 'none', md: 'block' },
          '& .MuiDrawer-paper': railPaperSx,
        }}
        open
      >
        {railContent()}
      </Drawer>

      {/* Temporary dark sidebar on mobile (overlay). */}
      <Drawer
        variant="temporary"
        open={mobileDrawerOpen}
        onClose={handleMobileDrawerToggle}
        ModalProps={{ keepMounted: true }} // perf: faster mobile open
        sx={{
          display: { xs: 'block', md: 'none' },
          '& .MuiDrawer-paper': railPaperSx,
        }}
      >
        {railContent(handleMobileNavItemSelect)}
      </Drawer>

      {/* Content column — light top bar + main region. */}
      <Box sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <AppBar
          position="static"
          elevation={0}
          sx={{
            backgroundColor: 'background.paper',
            color: 'text.primary',
            borderBottom: '1px solid',
            borderColor: 'divider',
          }}
        >
          <Toolbar>
            {/* Mobile-only menu button. Hidden on desktop where the rail is permanent. */}
            <IconButton
              color="inherit"
              edge="start"
              onClick={handleMobileDrawerToggle}
              aria-label={intl.formatMessage({ id: 'layout.openNav' })}
              sx={{ mr: 1, display: { xs: 'inline-flex', md: 'none' } }}
            >
              <MenuIcon />
            </IconButton>

            <Box sx={{ flexGrow: 1 }} />

            {user && (
              <>
                {/* App-provided switcher (tenant or context). Renders nothing if omitted. */}
                {switcher && <Box sx={{ mr: 1 }}>{switcher}</Box>}
                <IconButton
                  edge="end"
                  onClick={handleMenuOpen}
                  aria-label={userMenuLabel}
                  aria-controls={menuOpen ? userMenuId : undefined}
                  aria-haspopup="true"
                  aria-expanded={menuOpen}
                >
                  <Avatar
                    sx={{
                      width: 32,
                      height: 32,
                      fontSize: 14,
                      backgroundColor: 'primary.main',
                      color: 'primary.contrastText',
                    }}
                  >
                    {avatarInitial}
                  </Avatar>
                </IconButton>
                <Menu
                  id={userMenuId}
                  anchorEl={menuAnchor}
                  open={menuOpen}
                  onClose={handleMenuClose}
                  anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                  transformOrigin={{ vertical: 'top', horizontal: 'right' }}
                  // MUI v7 — `slotProps.list` replaces v5's `MenuListProps`.
                  slotProps={{ list: { 'aria-label': userMenuLabel } }}
                >
                  <Box sx={{ px: 2, py: 1 }}>
                    <Typography variant="caption" color="text.secondary" component="div">
                      <FormattedMessage id="layout.signedInAs" />
                    </Typography>
                    {fullName && (
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {fullName}
                      </Typography>
                    )}
                    {/* When a name is shown the email is the secondary line;
                        with no name the email is the primary identity. */}
                    <Typography
                      variant="body2"
                      color={fullName ? 'text.secondary' : 'text.primary'}
                    >
                      {user.email}
                    </Typography>
                  </Box>
                  <MenuItem onClick={handleAccount}>
                    <FormattedMessage id="layout.account" />
                  </MenuItem>
                  <MenuItem onClick={handleSignOut}>
                    <FormattedMessage id="layout.signOut" />
                  </MenuItem>
                </Menu>
              </>
            )}
          </Toolbar>
        </AppBar>

        <Box component="main" id="main-content" sx={{ flexGrow: 1 }}>
          <Container maxWidth="lg" sx={{ py: 4 }}>
            {tenantLoading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
                <CircularProgress aria-label={intl.formatMessage({ id: 'layout.loadingSession' })} />
              </Box>
            ) : (
              <Outlet />
            )}
          </Container>
        </Box>
      </Box>
    </Box>
  );
}
