// ---------------------------------------------------------------------------
// <ErrorBoundary> tests — the "never render internal error details" invariant.
//
// ErrorBoundary's security contract (module header): on a render-phase throw,
// log to console.error for monitoring but render ONLY a generic recovery UI —
// never the caught error's message/stack, because leaking internals in an
// admin/PHI UI is a real-world risk. These tests pin that contract so a
// regression that swapped the hardcoded copy for `error.message` is caught.
// ---------------------------------------------------------------------------

import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from './ErrorBoundary';

const SECRET = 'SECRET_INTERNAL_DETAIL_token=sk_live_should_never_render';
const SUPPORT_EMAIL = 'support@example.com';

function Boom(): React.JSX.Element {
  throw new Error(SECRET);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<ErrorBoundary>', () => {
  it('renders the generic fallback + support email and NEVER the caught error detail', () => {
    // React logs caught boundary errors to console.error in addition to our
    // componentDidCatch sink — silence the noise so the run stays clean.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <ErrorBoundary supportEmail={SUPPORT_EMAIL}>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Something went wrong.')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(SUPPORT_EMAIL.replace('.', '\\.')))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();

    // The security invariant: the internal error detail must not reach the DOM.
    expect(document.body.textContent).not.toContain(SECRET);
    expect(screen.queryByText(new RegExp(SECRET))).not.toBeInTheDocument();

    errorSpy.mockRestore();
  });

  it('logs the render error to console.error (the monitoring sink)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <ErrorBoundary supportEmail={SUPPORT_EMAIL}>
        <Boom />
      </ErrorBoundary>,
    );

    // componentDidCatch funnels render-phase errors to console.error so
    // CloudWatch RUM / Sentry hooks capture them. The logged label must not
    // carry an app-specific `[tag]` prefix (public-package hygiene — this lib
    // is consumed by multiple apps, so a hardcoded app tag would be wrong).
    expect(errorSpy).toHaveBeenCalledWith('Render error', expect.any(Error), expect.anything());
    const loggedFirstArgs = errorSpy.mock.calls.map((c) => String(c[0]));
    expect(loggedFirstArgs.some((m) => /^\s*\[[a-z][a-z0-9-]*\]/i.test(m))).toBe(false);

    errorSpy.mockRestore();
  });

  it('renders children unchanged when no error is thrown', () => {
    render(
      <ErrorBoundary supportEmail={SUPPORT_EMAIL}>
        <div data-testid="ok">healthy child</div>
      </ErrorBoundary>,
    );

    expect(screen.getByTestId('ok')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong.')).not.toBeInTheDocument();
  });
});
