import { defineConfig } from 'tsup';

/**
 * Dual ESM + CJS build for the browser.
 *
 * tsup auto-externalizes everything in `dependencies` + `peerDependencies`,
 * so React, MUI, Emotion, TanStack Query, Amplify, react-intl, react-router,
 * the SDK, and the leaf utils (jose, qrcode.react, zxcvbn) all stay external —
 * the consuming app supplies them. We ship only this package's own source.
 *
 * JSX uses the automatic runtime (matches `"jsx": "react-jsx"` in tsconfig).
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  outExtension: ({ format }) => ({ js: format === 'esm' ? '.mjs' : '.js' }),
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  splitting: false,
  target: 'es2022',
  esbuildOptions: (options) => {
    options.jsx = 'automatic';
  },
});
