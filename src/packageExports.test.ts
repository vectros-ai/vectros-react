/**
 * Guards the package's published entry points. The CommonJS build must use the `.cjs` extension (this package is
 * `"type": "module"`, so a CommonJS `.js` file would be loaded as ESM and `require()` would fail), and every
 * `main`/`exports` target must be a file the build emits: `.mjs` and `.d.ts` for `import`, `.cjs` and `.d.cts` for
 * `require`, for the main entry, the headless `/core` entry and each provider subpath.
 *
 * It also walks the source import graph of `/core` and fails if any module it reaches imports a web-only package or a
 * sign-in provider, so `/core` stays loadable in React Native and on a server with only its required peers installed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const pkg = JSON.parse(read('../package.json')) as {
  type: string;
  main: string;
  module: string;
  types: string;
  exports: Record<string, { import: { types: string; default: string }; require: { types: string; default: string } }>;
};
const tsup = read('../tsup.config.ts');

describe('published entry points', () => {
  it('the build emits .mjs for ESM and .cjs for CommonJS', () => {
    expect(tsup).toMatch(/format === 'esm' \? '\.mjs' : '\.cjs'/);
  });

  it('main, module and types point at the emitted files', () => {
    expect(pkg.type).toBe('module');
    expect(pkg.main).toBe('./dist/index.cjs');
    expect(pkg.module).toBe('./dist/index.mjs');
    expect(pkg.types).toBe('./dist/index.d.ts');
  });

  it('every export maps import to .mjs/.d.ts and require to .cjs/.d.cts', () => {
    const subpaths = Object.keys(pkg.exports).sort();
    expect(subpaths).toEqual(['.', './core', './providers/auth0', './providers/cognito', './providers/expo', './public']);
    for (const [key, cond] of Object.entries(pkg.exports)) {
      expect(cond.import.default, key).toMatch(/\.mjs$/);
      expect(cond.import.types, key).toMatch(/\.d\.ts$/);
      expect(cond.require.default, key).toMatch(/\.cjs$/);
      expect(cond.require.types, key).toMatch(/\.d\.cts$/);
      expect(cond.require.default.replace(/\.cjs$/, ''), key).toBe(cond.import.default.replace(/\.mjs$/, ''));
    }
  });

  it('typesVersions maps every subpath to its import types, for TypeScript resolution that ignores exports (node10)', () => {
    const typesVersions = (JSON.parse(read('../package.json')) as { typesVersions: Record<string, Record<string, string[]>> })
      .typesVersions['*'] as Record<string, string[]>;
    const subpaths = Object.keys(pkg.exports).filter((key) => key !== '.');
    expect(Object.keys(typesVersions).sort()).toEqual(subpaths.map((key) => key.slice(2)).sort());
    for (const key of subpaths) {
      expect(typesVersions[key.slice(2)], key).toEqual([pkg.exports[key]?.import.types]);
    }
  });

  it('the entries the exports map names are the entries the build compiles', () => {
    expect(tsup).toContain("'src/core.ts'");
    expect(tsup).toContain("'src/public.ts'");
    expect(tsup).toContain("'src/auth/providers/cognito.ts'");
    expect(tsup).toContain("'src/auth/providers/expo.ts'");
    expect(tsup).toContain("'src/auth/providers/auth0.ts'");
  });
});

/** The packages `/core` must never load at runtime: the web UI kit and every sign-in provider's SDK. */
const WEB_ONLY = ['@mui/', '@emotion/', 'react-dom', 'react-router', 'aws-amplify', '@auth0/', 'expo-', 'qrcode.react', '@zxcvbn-ts/'];

const srcDir = dirname(fileURLToPath(import.meta.url));

/** Value (non-type-only) import and re-export specifiers of one source file, including `import('x')` and `require('x')`. */
function valueSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const statement = /^\s*(import|export)\s+(type\s+)?[^;]*?from\s+['"]([^'"]+)['"]/gms;
  for (const m of source.matchAll(statement)) {
    if (!m[2]) specs.push(m[3] as string);
  }
  for (const m of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) specs.push(m[1] as string);
  // Dynamic imports and require calls load at runtime too.
  for (const m of source.matchAll(/\b(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1] as string);
  return specs;
}

function resolveRelative(fromFile: string, spec: string): string {
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsSync(candidate) && !candidate.endsWith('/') && /\.(ts|tsx|json)$/.test(candidate)) return candidate;
  }
  throw new Error(`cannot resolve ${spec} from ${fromFile}`);
}

/** Every package `entry` reaches at runtime, with the first file that imports it. */
function reachablePackages(entry: string): Map<string, string> {
  const seen = new Set<string>();
  const packages = new Map<string, string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    if (file.endsWith('.json')) continue;
    for (const spec of valueSpecifiers(readFileSync(file, 'utf8'))) {
      if (spec.startsWith('.')) queue.push(resolveRelative(file, spec));
      else if (!packages.has(spec)) packages.set(spec, file.slice(srcDir.length + 1));
    }
  }
  return packages;
}

describe('the providers/expo entry', () => {
  it('imports no package at runtime: the app passes in its Expo modules', () => {
    expect([...reachablePackages(resolve(srcDir, 'auth/providers/expo.ts')).keys()]).toEqual([]);
  });
});

describe('the /public entry', () => {
  const packages = reachablePackages(resolve(srcDir, 'public.ts'));

  it('reaches no web-only package and no sign-in provider SDK (React Native and server renderers can use it)', () => {
    const offending = [...packages].filter(([spec]) => WEB_ONLY.some((p) => spec === p || spec.startsWith(p)));
    expect(offending).toEqual([]);
  });

  it('loads only the SDK and TanStack Query at runtime', () => {
    expect([...packages.keys()].sort()).toEqual(['@tanstack/react-query', '@vectros-ai/sdk']);
  });
});

describe('the /core entry', () => {
  const packages = reachablePackages(resolve(srcDir, 'core.ts'));

  it('reaches no web-only package and no sign-in provider SDK', () => {
    const offending = [...packages].filter(([spec]) => WEB_ONLY.some((p) => spec === p || spec.startsWith(p)));
    expect(offending).toEqual([]);
  });

  it('loads only its required peers at runtime', () => {
    expect([...packages.keys()].sort()).toEqual(['@tanstack/react-query', 'react', 'react-intl']);
  });

  it('the walker sees through to the packages a component imports (control: the root entry reaches MUI)', () => {
    const root = reachablePackages(resolve(srcDir, 'index.ts'));
    expect([...root.keys()].some((spec) => spec.startsWith('@mui/'))).toBe(true);
  });

  it('every web peer the root entry needs is an optional peer, and the /core peers stay required', () => {
    const meta = (JSON.parse(read('../package.json')) as { peerDependenciesMeta: Record<string, { optional?: boolean }> })
      .peerDependenciesMeta;
    for (const peer of ['@mui/material', '@mui/icons-material', '@emotion/react', '@emotion/styled', 'react-dom', 'react-router']) {
      expect(meta[peer]?.optional, peer).toBe(true);
    }
    for (const peer of ['react', 'react-intl', '@tanstack/react-query', '@vectros-ai/sdk']) {
      expect(meta[peer]?.optional, peer).not.toBe(true);
    }
  });
});
