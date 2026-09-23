// ---------------------------------------------------------------------------
// isSafeHref — may a host-supplied link target become an anchor's `href`?
//
// A result's `href` comes from the host application and lands in an anchor, where
// a script scheme (`javascript:...`) runs in the host's origin when clicked. The
// rule is a positive allowlist, so a scheme nobody thought of is refused rather than
// let through:
//   - `http:` / `https:` (any case) and `mailto:`
//   - an in-page fragment (`#...`)
//   - a rooted path that stays on the site (`/cases/1`)
//
// A rooted path is judged by the URL parser a browser uses, on the value exactly as
// it will be written: `//host` is protocol-relative, a browser reads a backslash as a
// slash, and it drops tabs and newlines inside a URL, so `/\host` and `/<TAB>/host`
// also leave the site. Anything else, including a relative path with no leading
// slash, is not a link.
//
// Internal to the package: not exported from the package entry point.
// ---------------------------------------------------------------------------

const ALLOWED_PREFIX = /^(?:https?:|mailto:|#)/i;

// Any origin works: it is only compared with itself.
const SITE_ORIGIN = 'https://site.invalid';

export function isSafeHref(href: string): boolean {
  // The type says string, but a host that reads its links from JSON or a loosely typed store can
  // hand over anything: a number or an array must not reach `startsWith`, and an object with a
  // `toString` must not pass the prefix test by being coerced.
  if (typeof href !== 'string') return false;
  if (ALLOWED_PREFIX.test(href)) return true;
  if (!href.startsWith('/')) return false;
  try {
    return new URL(href, SITE_ORIGIN).origin === SITE_ORIGIN;
  } catch {
    return false;
  }
}
