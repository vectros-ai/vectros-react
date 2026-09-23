// @vitest-environment node
// (Node's native URL parser is the WHATWG one a browser runs, and is much faster than
// jsdom's JS copy, which matters for the code-point sweep below.)

import { describe, expect, it } from 'vitest';

import { isSafeHref } from './safeHref';

const BS = String.fromCharCode(92);
const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const NBSP = String.fromCharCode(0xa0);

describe('isSafeHref', () => {
  it.each([
    '/',
    '/cases/case_1',
    '/cases/case_1?tab=notes#top',
    '/a//b',
    '/?q=//x',
    '/%2Fevil.example',
    'https://example.com/x',
    'http://example.com/x',
    'HTTPS://example.com/x',
    'mailto:someone@example.com',
    '#notes',
  ])('accepts %s', (href) => {
    expect(isSafeHref(href)).toBe(true);
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    `java${TAB}script:alert(1)`,
    `java${LF}script:alert(1)`,
    ' javascript:alert(1)',
    `${NBSP}javascript:alert(1)`,
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'blob:https://example.com/uuid',
    'file:///etc/passwd',
    'ftp://example.com/x',
    '//evil.example/x',
    '///evil.example',
    `/${BS}evil.example`,
    `/${BS}/evil.example`,
    `/${TAB}/evil.example`,
    `/${LF}/evil.example`,
    `/${CR}/evil.example`,
    `${BS}${BS}evil.example`,
    'cases/case_1',
    '?q=1',
    '',
    ' ',
  ])('rejects %j', (href) => {
    expect(isSafeHref(href)).toBe(false);
  });

  it.each([
    ['a number', 5],
    ['an array holding a rooted path', ['/cases/1']],
    ['an object whose toString is an allowed URL', { toString: () => 'https://example.com/' }],
    ['an object whose toString is a rooted path', { toString: () => '/cases/1' }],
    ['null', null],
    ['undefined', undefined],
    ['true', true],
  ])('rejects %s without throwing', (_name, value) => {
    expect(() => isSafeHref(value as unknown as string)).not.toThrow();
    expect(isSafeHref(value as unknown as string)).toBe(false);
  });

  // Every BMP code point right after the leading slash. The check is pinned to the
  // WHATWG URL parser (Node's implementation of the same algorithm a browser runs): a
  // rooted path is accepted only if that parser resolves it to the same origin. This shows
  // the helper and the parser agree on every code point here; it does not run a browser.
  // Control: a regex that rejects only a second slash accepts off-origin values in
  // this same set, so a sweep that could not tell them apart would prove nothing.
  it('never accepts a rooted path a browser would send to another origin, for any code point after the slash', () => {
    const origin = 'https://site.example';
    const secondSlashOnly = (h: string): boolean => /^\/(?!\/)/.test(h);
    const violations: string[] = [];
    let offOrigin = 0;
    let controlMisses = 0;
    for (let cp = 0; cp <= 0xffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      for (const href of [`/${ch}evil.example`, `/${ch}/evil.example`, `/${ch}${ch}evil.example`]) {
        if (new URL(href, origin).origin === origin) continue;
        offOrigin += 1;
        if (secondSlashOnly(href)) controlMisses += 1;
        if (isSafeHref(href)) violations.push(`U+${cp.toString(16)} ${JSON.stringify(href)}`);
      }
    }
    expect(violations).toEqual([]);
    expect(offOrigin).toBeGreaterThan(0);
    expect(controlMisses).toBeGreaterThan(0);
  }, 120_000);

  // Whatever the allowlist accepts must, once the WHATWG URL parser has parsed it, be an
  // allowed scheme (or a fragment / same-site path, which resolve to the page's own scheme):
  // no code point before or inside a scheme may turn a script scheme into an accepted
  // value. Control: a denylist that only looks for a leading `javascript:` accepts
  // unsafe values on this same set, so a sweep that could not tell them apart would
  // prove nothing.
  it('never accepts a value a browser would read as a script scheme, for any code point before or inside the scheme', () => {
    const allowed = new Set(['http:', 'https:', 'mailto:']);
    const protocolOf = (href: string): string => {
      try {
        return new URL(href, 'https://site.example').protocol;
      } catch {
        return 'unparseable';
      }
    };
    const denylist = (href: string): boolean => !/^\s*javascript:/i.test(href);
    const violations: string[] = [];
    let unsafeInputs = 0;
    let denylistAcceptsUnsafe = 0;
    let accepted = 0;
    for (let cp = 0; cp <= 0xffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      for (const href of [`${ch}javascript:alert(1)`, `java${ch}script:alert(1)`, `${ch}https://a.example`]) {
        const unsafe = !allowed.has(protocolOf(href));
        if (unsafe) unsafeInputs += 1;
        if (unsafe && denylist(href)) denylistAcceptsUnsafe += 1;
        if (!isSafeHref(href)) continue;
        accepted += 1;
        if (unsafe) violations.push(`U+${cp.toString(16)} ${JSON.stringify(href)} -> ${protocolOf(href)}`);
      }
    }
    expect(violations).toEqual([]);
    expect(accepted).toBeGreaterThan(0);
    expect(unsafeInputs).toBeGreaterThan(0);
    expect(denylistAcceptsUnsafe).toBeGreaterThan(0);
  }, 120_000);
});
