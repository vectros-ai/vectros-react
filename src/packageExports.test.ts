/**
 * Guards the package's published entry points. The CommonJS build must use the `.cjs` extension (this package is
 * `"type": "module"`, so a CommonJS `.js` file would be loaded as ESM and `require()` would fail), and every
 * `main`/`exports` target must be a file the build emits: `.mjs` and `.d.ts` for `import`, `.cjs` and `.d.cts` for
 * `require`, for the main entry and for each provider subpath.
 */
import { readFileSync } from 'node:fs';
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
    expect(subpaths).toEqual(['.', './providers/auth0', './providers/cognito']);
    for (const [key, cond] of Object.entries(pkg.exports)) {
      expect(cond.import.default, key).toMatch(/\.mjs$/);
      expect(cond.import.types, key).toMatch(/\.d\.ts$/);
      expect(cond.require.default, key).toMatch(/\.cjs$/);
      expect(cond.require.types, key).toMatch(/\.d\.cts$/);
      expect(cond.require.default.replace(/\.cjs$/, ''), key).toBe(cond.import.default.replace(/\.mjs$/, ''));
    }
  });

  it('the provider entries the exports map names are the entries the build compiles', () => {
    expect(tsup).toContain("'src/auth/providers/cognito.ts'");
    expect(tsup).toContain("'src/auth/providers/auth0.ts'");
  });
});
