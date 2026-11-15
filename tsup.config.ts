import { defineConfig } from 'tsup';

/**
 * Dual ESM + CJS build for the browser.
 *
 * tsup auto-externalizes everything in `dependencies` + `peerDependencies`,
 * so React, MUI, Emotion, TanStack Query, Amplify, Auth0, react-intl,
 * react-router, the SDK, and the leaf utils (jose, qrcode.react, zxcvbn)
 * all stay external — npm installs them as ordinary transitive dependencies
 * for anyone who installs this package. We ship only this package's own source.
 *
 * SEVERAL entry points, not one: this is load-bearing, not stylistic.
 *
 * `src/core.ts` is the headless entry (`@vectros-ai/react/core`). Nothing it
 * reaches imports MUI, Emotion, react-dom or react-router, so a React Native
 * app or a server renderer can load it with those peers absent. The main
 * entry (`src/index.ts`) re-exports it and adds the MUI components.
 *
 * Neither of those imports any sign-in provider's concrete class, only their
 * types (type-only imports/exports are erased, so they don't pull the
 * provider SDK's runtime import into the bundle). Each provider lives in its
 * OWN entry (`src/auth/providers/*.ts`), each importing only its own SDK. If a
 * provider's class were instead re-exported as a VALUE from the main entry,
 * esbuild would bundle a static top-level `import ... from 'aws-amplify/auth'`
 * (or `@auth0/auth0-spa-js`) into the ONE file every
 * consumer imports, so a consumer without that SDK would fail to resolve it
 * the moment they imported ANYTHING from this package, defeating the whole
 * point of making the provider SDKs optional peers. (The Expo provider imports
 * no package at all: the app passes its Expo modules in.) See package.json's
 * `exports` map for the matching subpaths.
 *
 * JSX uses the automatic runtime (matches `"jsx": "react-jsx"` in tsconfig).
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/core.ts', 'src/auth/providers/cognito.ts', 'src/auth/providers/auth0.ts', 'src/auth/providers/expo.ts'],
  format: ['esm', 'cjs'],
  outExtension: ({ format }) => ({ js: format === 'esm' ? '.mjs' : '.cjs' }),
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  // MUST be true with several entries: without it, each entry bundle inlines its
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
