// ---------------------------------------------------------------------------
// VersionUpdateBanner tests — the full detection matrix (immediate check,
// interval, focus/visibility), the three-way state machine (match→silent,
// mismatch→prompt, dismiss→hide-and-never-re-nag), the disable cases (dev id,
// failed fetch, network reject, missing version field), and that Refresh
// reloads while Dismiss hides without reloading.
// ---------------------------------------------------------------------------

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VersionUpdateBanner } from './VersionUpdateBanner';

// A reassignable fetch stub: tests mutate `respond` to change what the next
// poll sees (a deploy happening mid-session), or throw to simulate an offline
// reject. Returns the current `respond()` value on every call.
let respond: () => { ok: boolean; body: unknown };
let fetchMock: ReturnType<typeof vi.fn>;

function stubFetch(): void {
  fetchMock = vi.fn(async () => {
    const { ok, body } = respond();
    return { ok, json: async () => body } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
}

const reload = vi.fn();

beforeEach(() => {
  reload.mockReset();
  respond = () => ({ ok: true, body: { version: 'build-2' } });
  stubFetch();
  // window.location.reload is non-configurable in jsdom; replace via defineProperty.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('VersionUpdateBanner — detection', () => {
  it('shows the prompt when the immediate check finds a different version', async () => {
    render(<VersionUpdateBanner currentVersion="build-1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/new version/i);
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  it('stays hidden when the deployed version matches', async () => {
    respond = () => ({ ok: true, body: { version: 'build-1' } });
    render(<VersionUpdateBanner currentVersion="build-1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('detects a newer version on a later interval poll', async () => {
    vi.useFakeTimers();
    respond = () => ({ ok: true, body: { version: 'build-1' } }); // matches at first
    render(<VersionUpdateBanner currentVersion="build-1" pollIntervalMs={5000} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); }); // immediate check
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    respond = () => ({ ok: true, body: { version: 'build-2' } }); // a deploy happens
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); }); // interval fires
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('detects a newer version when a backgrounded tab regains focus', async () => {
    vi.useFakeTimers();
    respond = () => ({ ok: true, body: { version: 'build-1' } });
    render(<VersionUpdateBanner currentVersion="build-1" pollIntervalMs={9_000_000} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    respond = () => ({ ok: true, body: { version: 'build-2' } });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});

describe('VersionUpdateBanner — no prompt', () => {
  it('never polls for a non-deploy (local dev) build id', () => {
    render(<VersionUpdateBanner currentVersion="dev" />);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('stays hidden when the manifest fetch is not ok', async () => {
    respond = () => ({ ok: false, body: {} });
    render(<VersionUpdateBanner currentVersion="build-1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('stays silent when the fetch rejects (offline / abort)', async () => {
    fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<VersionUpdateBanner currentVersion="build-1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('stays silent when the manifest has no version field', async () => {
    respond = () => ({ ok: true, body: { note: 'no version here' } });
    render(<VersionUpdateBanner currentVersion="build-1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('VersionUpdateBanner — actions', () => {
  it('reloads the page when Refresh is clicked', async () => {
    const user = userEvent.setup();
    render(<VersionUpdateBanner currentVersion="build-1" />);
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('dismissal hides the banner without reloading', async () => {
    const user = userEvent.setup();
    render(<VersionUpdateBanner currentVersion="build-1" />);
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not poll again after dismiss — no re-nag on the next tick/focus', async () => {
    vi.useFakeTimers();
    render(<VersionUpdateBanner currentVersion="build-1" pollIntervalMs={5000} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); }); // → available
    expect(screen.getByRole('alert')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    const callsAtDismiss = fetchMock.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000); // several intervals
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fetchMock.mock.calls.length).toBe(callsAtDismiss); // polling stopped
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); // stays hidden
  });
});
