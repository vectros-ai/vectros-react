import { defineConfig } from 'tsup';

/**
 * Dual ESM + CJS build for the browser.
 *
 * tsup auto-externalizes everything in `dependencies` + `peerDependencies`,
 * so React, MUI, Emotion, TanStack Query, Amplify, Auth0, react-intl,
 * react-router, the SDK, and the leaf utils (jose, qrcode.react, zxcvbn) all
 * stay external — the consuming app supplies them. We ship only this
 * package's own source.
 *
 * THREE entry points, not one — this is load-bearing, not stylistic. The
 * main entry (`src/index.ts`) never imports either provider's concrete
 * class, only their types (type-only imports/exports are erased, so they
 * don't pull the SDK's runtime import into the bundle). Each provider lives
 * in its OWN entry (`src/auth/providers/{cognito,auth0}.ts`), each importing
 * only its own SDK. If a provider's class were instead re-exported as a
 * VALUE from the main entry, esbuild would bundle a static top-level
 * `import ... from 'aws-amplify/auth'` (or `@auth0/auth0-spa-js`) into the
 * ONE file every consumer imports — meaning an Auth0-only consumer's
 * bundler would fail to resolve `aws-amplify` (and vice versa) the moment
 * they imported ANYTHING from this package, defeating the whole point of
 * making both peer dependencies optional. See package.json's `exports` map
 * for the matching subpaths (`./providers/cognito`, `./providers/auth0`).
 *
 * JSX uses the automatic runtime (matches `"jsx": "react-jsx"` in tsconfig).
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/auth/providers/cognito.ts', 'src/auth/providers/auth0.ts'],
  format: ['esm', 'cjs'],
  outExtension: ({ format }) => ({ js: format === 'esm' ? '.mjs' : '.js' }),
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  // MUST be true with 3+ entries: without it, each entry bundle inlines its
  // OWN copy of every shared internal module (errors.ts, types.ts, etc.)
  // instead of importing one shared chunk. That silently breaks `instanceof
  // AuthError` across entry boundaries (e.g. AuthError thrown inside
  // cognito.mjs failing an instanceof check against the AuthError imported
  // from index.mjs) — two distinct class identities, same source. Splitting
  // hoists shared code to one physical chunk every entry imports from, so
  // there's exactly one class identity regardless of which entry point a
  // consumer loaded it through.
  splitting: true,
  target: 'es2022',
  esbuildOptions: (options) => {
    options.jsx = 'automatic';
  },
});
