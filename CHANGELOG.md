# Changelog

All notable changes to `@vectros-ai/react` are documented here.
This project adheres to [Semantic Versioning](https://semver.org).

## 0.5.2 — 2026-07-03

### Changed

- Updated the `@vectros-ai/sdk` version the toolkit is built and tested against to
  **0.32.0**. No functional changes; the peer-dependency range (`>=0.9.0`) is
  unchanged.

## 0.5.1 — 2026-07-01

### Fixed

- Sidebar navigation no longer renders empty on the first sign-in of a session.
  `CurrentTenantProvider` now reloads the tenant memberships when the signed-in
  identity changes, so scope-gated nav items appear immediately after signing in
  rather than only after a full page reload.

## 0.5.0 — 2026-06-20

Initial public release of the Vectros React toolkit.

### Added

- The auth stack, Vectros API token cache, MFA flow, and UI primitives shared by
  the Vectros reference apps.
- Provider-agnostic authentication: swap Cognito for Auth0, Clerk, or any OIDC
  provider behind a single adapter.
