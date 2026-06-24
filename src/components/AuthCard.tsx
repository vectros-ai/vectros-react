// ---------------------------------------------------------------------------
// AuthCard — shared centered-card shell for public auth pages.
//
// All public auth flows (login, signup-accept, signup-confirm, forgot-password)
// share the same visual frame: brand mark at top, a card with title + body
// content, optional footer link below. Centralizing it here means:
//   - Re-skinning a fork is a single-file change (uses BRAND.productName).
//   - Visual consistency across the auth surface is automatic.
//   - A11y landmarks are uniform — `<main>` wraps the card on every page.
// ---------------------------------------------------------------------------

import type { ReactNode } from 'react';
import { Box, Card, CardContent, Container, Stack, Typography } from '@mui/material';

export interface AuthCardProps {
  /**
   * Brand mark shown above the card (the product name). Injected by the host
   * app so the library component stays brand-agnostic / forkable.
   */
  readonly brandName: string;
  /**
   * Page heading — rendered as the page's h1 inside the card. The brand
   * mark above is intentionally NOT a heading (variant h5 default) so each
   * public page has exactly one h1 (the page title).
   */
  readonly title: string;
  /** Optional subtitle/lead paragraph below the title. */
  readonly subtitle?: string;
  /** Page body — usually a form. */
  readonly children: ReactNode;
  /** Optional footer area below the card (e.g. "Forgot password?" link). */
  readonly footer?: ReactNode;
}

export function AuthCard({
  brandName,
  title,
  subtitle,
  children,
  footer,
}: AuthCardProps): React.JSX.Element {
  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'background.default',
      }}
    >
      <Container
        component="main"
        maxWidth="xs"
        sx={{
          flexGrow: 1,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          py: { xs: 4, sm: 6 },
        }}
      >
        <Stack alignItems="stretch" spacing={3}>
          {/*
            Brand rendered as a non-heading <span> (component override
            REQUIRED — MUI's variant `h5` defaults to <h5>, which would
            still register as a heading and compete with the page title
            below).
          */}
          <Typography
            variant="h5"
            component="span"
            sx={{ fontWeight: 700, textAlign: 'center', display: 'block' }}
          >
            {brandName}
          </Typography>
          <Card sx={{ width: '100%' }}>
            <CardContent sx={{ p: { xs: 3, sm: 4 } }}>
              <Stack spacing={3}>
                <Box>
                  <Typography variant="h5" component="h1" sx={{ fontWeight: 700 }}>
                    {title}
                  </Typography>
                  {subtitle && (
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                      {subtitle}
                    </Typography>
                  )}
                </Box>
                {children}
              </Stack>
            </CardContent>
          </Card>
          {footer && <Box sx={{ textAlign: 'center' }}>{footer}</Box>}
        </Stack>
      </Container>
    </Box>
  );
}
