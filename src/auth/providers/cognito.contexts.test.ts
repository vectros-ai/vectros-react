// ---------------------------------------------------------------------------
// CognitoAuthProvider.listAppContexts — the app-context drain.
//
// This is the OWNER half of a context switcher, so an incomplete result does not
// read as an error: a context that silently goes missing looks exactly like one
// the operator has no access to. The drain therefore follows the opaque
// `nextCursor` and stops ONLY when it goes null — never on a short or empty
// page, which is normal because filtering is applied per page after that page's
// cursor is captured — and refuses rather than returning a partial result.
//
// The fetch fake ENFORCES the cursor contract (it rejects any `startFrom` it did
// not itself issue, as the API does) rather than serving pages from an internal
// counter, which would pass a drain that invented its own cursors.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('aws-amplify/auth', () => ({
  signIn: vi.fn(),
  signOut: vi.fn(),
  confirmSignIn: vi.fn(),
  confirmResetPassword: vi.fn(),
  confirmSignUp: vi.fn(),
  fetchAuthSession: vi.fn(),
  fetchMFAPreference: vi.fn(),
  fetchUserAttributes: vi.fn(),
  getCurrentUser: vi.fn(),
  resendSignUpCode: vi.fn(),
  resetPassword: vi.fn(),
  setUpTOTP: vi.fn(),
  signUp: vi.fn(),
  updateMFAPreference: vi.fn(),
  updatePassword: vi.fn(),
  verifyTOTPSetup: vi.fn(),
}));

import { CognitoAuthProvider } from './cognito';

interface Page {
  readonly ids: readonly string[];
  /** The cursor this page hands back; null marks it terminal. */
  readonly nextCursor: string | null;
}

/** A cursor in the opaque wire form — deliberately not derivable from any row. */
const cursor = (n: number): string => `v1.${btoa(`nonce-${n}|ct|tag`)}`;

/**
 * Install a `fetch` fake over `/developer/app-contexts` that serves `pages` and
 * rejects a `startFrom` it never issued (HTTP 400), plus whatever status
 * overrides a cell needs. Returns the recorded `startFrom` values.
 */
function stubFetch(
  pages: ReadonlyArray<Page>,
  statusAt?: { readonly page: number; readonly status: number },
): { startFroms: Array<string | null> } {
  const startFroms: Array<string | null> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const startFrom = new URL(url).searchParams.get('startFrom');
      startFroms.push(startFrom);
      const index =
        startFrom === null
          ? 0
          : pages.findIndex((_, i) => i > 0 && pages[i - 1]?.nextCursor === startFrom);
      if (index < 0) {
        return Promise.resolve({ ok: false, status: 400, text: () => Promise.resolve('bad cursor') });
      }
      if (statusAt && statusAt.page === index) {
        return Promise.resolve({
          ok: false,
          status: statusAt.status,
          text: () => Promise.resolve(''),
        });
      }
      const page = pages[index];
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: (page?.ids ?? []).map((id) => ({ contextId: id, name: id })),
            nextCursor: page?.nextCursor ?? null,
          }),
      });
    }),
  );
  return { startFroms };
}

function provider(): CognitoAuthProvider {
  const p = new CognitoAuthProvider({
    developerApiBase: 'https://api.test',
    productName: 'Test',
  });
  // Bypass Amplify: the drain is what is under test, not session resolution.
  vi.spyOn(p, 'getIdToken').mockResolvedValue('id-token');
  (p as unknown as { resolveTenantKind: () => Promise<string> }).resolveTenantKind = () =>
    Promise.resolve('test');
  return p;
}

const ids = (rows: ReadonlyArray<{ contextId: string }>): string[] => rows.map((r) => r.contextId);

describe('CognitoAuthProvider.listAppContexts — draining', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('echoes the issued cursor back rather than inventing one', async () => {
    const { startFroms } = stubFetch([
      { ids: ['a'], nextCursor: cursor(1) },
      { ids: ['b'], nextCursor: null },
    ]);

    expect(ids(await provider().listAppContexts('tnt_1'))).toEqual(['a', 'b']);
    expect(startFroms).toEqual([null, cursor(1)]);
  });

  it('CONTINUES through an empty page that still carries a live cursor', async () => {
    // Filtering runs per page after that page's cursor is captured, so an empty
    // page with rows behind it is normal. Stopping here silently drops them.
    stubFetch([
      { ids: ['a'], nextCursor: cursor(1) },
      { ids: [], nextCursor: cursor(2) },
      { ids: ['b'], nextCursor: null },
    ]);

    expect(ids(await provider().listAppContexts('tnt_1'))).toEqual(['a', 'b']);
  });

  it('drains a listing that ends exactly on the page ceiling', async () => {
    // A full final page still carries a live cursor, so proving exhaustion costs
    // one request beyond the last page of data. Charging that probe to the
    // ceiling would discard a COMPLETE read at exactly the ceiling's worth of
    // rows. 50 pages of data + the probe.
    const pages: Page[] = [];
    for (let i = 0; i < 50; i++) pages.push({ ids: [`c${i}`], nextCursor: cursor(i + 1) });
    pages.push({ ids: [], nextCursor: null }); // the probe
    stubFetch(pages);

    expect(await provider().listAppContexts('tnt_1')).toHaveLength(50);
  });

  it('THROWS rather than returning a partial result when the cursor never goes null', async () => {
    const pages: Page[] = [];
    for (let i = 0; i < 60; i++) pages.push({ ids: [`c${i}`], nextCursor: cursor(i + 1) });
    stubFetch(pages);

    await expect(provider().listAppContexts('tnt_1')).rejects.toThrow(
      /still not exhausted after 51 requests \(51 read\)/,
    );
  });

  it('returns empty on a first-page 403 — that means "nothing here for you"', async () => {
    stubFetch([{ ids: ['a'], nextCursor: null }], { page: 0, status: 403 });

    await expect(provider().listAppContexts('tnt_1')).resolves.toEqual([]);
  });

  it('THROWS on a mid-drain 403 rather than returning the pages already read', async () => {
    // The same status means something different once the listing is under way:
    // it interrupted a drain, and handing back pages 1..N-1 is the silent
    // truncation the loop exists to avoid.
    stubFetch(
      [
        { ids: ['a'], nextCursor: cursor(1) },
        { ids: ['b'], nextCursor: cursor(2) },
        { ids: ['c'], nextCursor: null },
      ],
      { page: 1, status: 403 },
    );

    await expect(provider().listAppContexts('tnt_1')).rejects.toThrow(
      /403 part-way through the listing \(1 read\)/,
    );
  });
});
