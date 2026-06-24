// ---------------------------------------------------------------------------
// Top-level error boundary.
//
// React's error boundaries catch render-phase exceptions and event-handler
// exceptions that bubble. They DO NOT catch async/Promise rejections
// (`window.addEventListener('unhandledrejection', ...)` covers those) nor
// errors inside event handlers that don't bubble. So this is necessary but
// not sufficient — we also install global handlers in main.tsx.
//
// In production we surface a recovery action ("Reload") rather than a
// developer-style stack trace. The error is logged to console.error so
// CloudWatch RUM (if/when wired) captures it, but never rendered to the
// user — leaking internals is a real-world risk for admin UIs.
//
// i18n note: ErrorBoundary lives OUTSIDE IntlProvider in the tree (see
// main.tsx) so that a failure inside react-intl itself still surfaces a
// readable message. Copy here is intentionally hardcoded English + BRAND
// interpolation — DO NOT route through react-intl, even if all other
// admin-app strings do.
// ---------------------------------------------------------------------------

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Box, Button, Container, Stack, Typography } from '@mui/material';

export interface ErrorBoundaryProps {
  readonly children: ReactNode;
  /**
   * Support contact shown in the fallback's recovery copy. Injected by the host
   * app (this boundary intentionally renders OUTSIDE every other provider, so it
   * can't read brand from a context — hence a plain prop).
   */
  readonly supportEmail: string;
}

interface ErrorBoundaryState {
  readonly hasError: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(_error: Error): ErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Single sink for render-phase errors. console.error is the contract
    // CloudWatch RUM / Sentry-style monitoring hooks into. We deliberately
    // do NOT render the message — users should not see internal details.
    console.error('Render error', error, info.componentStack);
  }

  private readonly handleReload = (): void => {
    window.location.reload();
  };

  override render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }
    return (
      <Container maxWidth="sm" sx={{ py: 8 }}>
        <Stack spacing={3} alignItems="flex-start">
          <Typography variant="h4" component="h1">
            Something went wrong.
          </Typography>
          <Typography variant="body1" color="text.secondary">
            An unexpected error occurred. Please reload the page. If the problem continues, contact{' '}
            {this.props.supportEmail}.
          </Typography>
          <Box>
            <Button variant="contained" onClick={this.handleReload}>
              Reload
            </Button>
          </Box>
        </Stack>
      </Container>
    );
  }
}
