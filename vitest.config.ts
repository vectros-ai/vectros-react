import { defineConfig } from 'vitest/config';

// The package's own unit tests run against src (with intra-package mocking that
// a consuming app — which sees only the bundled dist — can't do). Peer deps
// (react, MUI, react-intl, react-router, …) resolve from the workspace-root
// node_modules, single-copy, so no dedupe is needed here.
export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
