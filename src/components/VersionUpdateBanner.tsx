// ---------------------------------------------------------------------------
// VersionUpdateBanner — a non-blocking "a new version is available" prompt.
//
// A single-page app served from immutable, content-hashed asset files has one
// failure mode a manual refresh always fixes but an untouched tab never sees:
// after a new deploy, the open tab still runs the OLD shell and lazily imports
// OLD chunk filenames. Those old chunks are kept around for in-flight tabs, but
// the tab is nonetheless a build behind and will eventually hit a route whose
// chunk no longer exists. This component closes that gap WITHOUT ever forcing a
// reload out from under the user: it polls a small `version.json` manifest the
// build emits, compares the deployed build id against the one baked into THIS
// bundle, and — only on a mismatch — shows a dismissible banner with a Refresh
// button. The reload is always user-initiated.
//
// The build id is injected by the host (it passes the value its bundler baked
// in), so this component stays bundler-agnostic and unit-testable. Emit the
// manifest as `{ "version": "<build id>" }` and serve it with a no-cache /
// no-store policy so the poll reads the freshly deployed value rather than an
// edge-cached copy.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Snackbar } from '@mui/material';

export interface VersionUpdateBannerProps {
  /**
   * The build id baked into the currently running bundle at build time. When
   * empty (or the placeholder used for local dev builds) the banner disables
   * itself and never polls — there is nothing meaningful to compare against.
   */
  readonly currentVersion: string;
  /** URL of the deployed version manifest. Defaults to `/version.json`. */
  readonly versionUrl?: string;
  /** How often to re-check, in milliseconds. Defaults to 60000 (60s). */
  readonly pollIntervalMs?: number;
  /** Banner body text. Defaults to a generic English message. */
  readonly message?: string;
  /** Label on the reload action. Defaults to "Refresh". */
  readonly refreshLabel?: string;
  /** Label on the dismiss action. Defaults to "Dismiss". */
  readonly dismissLabel?: string;
}

/** Build ids that mean "not a real deployed build" — never poll for these. */
const NON_DEPLOY_VERSIONS = new Set(['', 'dev', 'development']);

/**
 * Polls a `version.json` manifest and, when the deployed build id differs from
 * the running one, shows a non-blocking banner offering a user-initiated
 * refresh. Renders nothing until a newer version is detected.
 */
export function VersionUpdateBanner({
  currentVersion,
  versionUrl = '/version.json',
  pollIntervalMs = 60_000,
  message = 'A new version of this app is available.',
  refreshLabel = 'Refresh',
  dismissLabel = 'Dismiss',
}: VersionUpdateBannerProps): React.JSX.Element | null {
  // 'idle' → still polling; 'available' → newer build detected, banner shown;
  // 'dismissed' → user dismissed. Polling stops the moment we leave 'idle', so
  // a dismiss is respected (we never re-detect and re-nag on the next tick).
  const [status, setStatus] = useState<'idle' | 'available' | 'dismissed'>('idle');

  // Hold the running version in a ref so the polling effect can read the latest
  // value without re-subscribing (and re-arming its interval) on every render.
  const currentVersionRef = useRef(currentVersion);
  currentVersionRef.current = currentVersion;

  const enabled = !NON_DEPLOY_VERSIONS.has(currentVersion);

  const check = useCallback(async () => {
    try {
      // `no-store` plus a no-cache manifest behavior means the poll always sees
      // the deployed value, not a stale cached one. A failed/aborted fetch is
      // swallowed — a transient network blip must never surface a false prompt.
      const res = await fetch(versionUrl, { cache: 'no-store' });
      if (!res.ok) return;
      const data: unknown = await res.json();
      const raw =
        data && typeof data === 'object' && 'version' in data
          ? (data as { version: unknown }).version
          : undefined;
      // `?? ''` so a null/absent version collapses to '' (no banner) rather
      // than the string "null" (which would be truthy and falsely prompt).
      const deployed = String(raw ?? '');
      if (deployed && deployed !== currentVersionRef.current) {
        setStatus('available');
      }
    } catch {
      // Ignore — poll again on the next tick / focus.
    }
  }, [versionUrl]);

  useEffect(() => {
    if (!enabled || status !== 'idle') return;

    let cancelled = false;
    const runCheck = () => {
      if (!cancelled) void check();
    };

    // Poll on an interval, and opportunistically the moment a backgrounded tab
    // becomes visible or regains focus — the common "left it open overnight"
    // path where interval drift or throttling would otherwise delay detection.
    const intervalId = setInterval(runCheck, pollIntervalMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') runCheck();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', runCheck);

    // Kick an immediate check so a tab opened just after a deploy notices soon.
    runCheck();

    return () => {
      cancelled = true;
      clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', runCheck);
    };
  }, [enabled, status, pollIntervalMs, check]);

  if (status !== 'available') return null;

  return (
    <Snackbar
      open
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      // Never auto-hide — the prompt persists until the user acts or dismisses.
    >
      <Alert
        severity="info"
        variant="filled"
        action={
          <>
            <Button color="inherit" size="small" onClick={() => window.location.reload()}>
              {refreshLabel}
            </Button>
            <Button color="inherit" size="small" onClick={() => setStatus('dismissed')}>
              {dismissLabel}
            </Button>
          </>
        }
      >
        {message}
      </Alert>
    </Snackbar>
  );
}
