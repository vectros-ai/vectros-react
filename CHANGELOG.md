# Changelog

All notable changes to `@vectros-ai/react` are documented here.
This project adheres to [Semantic Versioning](https://semver.org).

## 0.7.0 — 2026-08-05

### Changed

- **`useScopeGate` now also exposes the session's own `identity` claim** (`ScopeGateValue.identity`
  and the new `decodeIdentity` export) — the ownership dimensions (`scope:org`, `scope:client`, etc.)
  the signed-in credential itself holds, decoded from the same token `can()` already reads. This
  answers a different question than `can(action)`: whether a session's own credential could
  legitimately be granted a specific identity value elsewhere (the platform's identity-conferral
  rule permits confering exactly the value you hold, never an arbitrary one) — useful for any surface
  that renders an identity-authoring control and needs to know, per session, whether it's reachable at
  all. Empty for a credential with no identity of its own (an account-level/owner session). Additive;
  existing `useScopeGate()`/`decodeAllowedActions` consumers are unaffected.

- **`useScopeGate`'s (and `RequireScope`'s / `ScopeGate`'s) `can(action)` now recognizes a
  `resource:ops` permission regardless of how it's granted.** A caller holding `users:c`, `users:r`
  and `users:u` as three separate entries, or one combined `users:cru` entry, both now satisfy
  `can('users:ru')` — previously only an exact string match against a single entry counted, so a
  permission split across several grants (or expressed with different but equivalent letters) could
  read as denied even though the caller held it. A grant that carries a qualifier (e.g.
  `documents:r:foo`) is narrower and is not unioned into an unqualified ask, and anything outside the
  compact `resource:ops` shape still matches only verbatim — this widens what `can()` recognizes as
  an equivalent grant, never what it treats as sufficient to satisfy one.

### Fixed

- **`listAppContexts` no longer returns a partial list of app contexts without saying so.** It pages
  through the developer API a hundred contexts at a time, bounded by a ceiling on how many pages it
  will chase. On reaching that ceiling it returned what it had, so a caller received a short list
  indistinguishable from a complete one — and because this list backs a context switcher, a missing
  context reads as "you do not have access to it" rather than as a failure. It now throws instead. A
  listing that ends exactly on the ceiling is still complete and still returned: confirming there is
  nothing further costs one more request, and that request is no longer counted against the ceiling.

- **An authorization failure part-way through that listing is no longer reported as an empty or short
  list.** A 401, 403 or 404 on the first page still yields an empty list — there is genuinely nothing
  to show. The same status arriving mid-listing means the enumeration was interrupted, and returning
  the pages already read would understate what exists; it now throws.

- **Test fixtures for `useScopeGate` / `ScopeGate` / `AppLayout` no longer use the retired
  `admin:<resource>` scope spelling as a stand-in for a grantable permission.** That form is not
  authorable vocabulary — the backend rejects it at grant time — so a fixture built on it could pass
  while asserting nothing about a permission an app could actually hold. Fixtures now use the real
  compact `resource:ops` form (e.g. `users:r`) throughout; behavior is unchanged.

### Changed

- Updated the `@vectros-ai/sdk` version the toolkit is built and tested against to **0.38.0**. No
  functional changes; the peer-dependency range (`>=0.9.0`) is unchanged.

## 0.6.1 — 2026-07-13

### Changed

- Documentation: added a "Security & trust" section to the README linking the
  compliance and trust guide. No code or API changes.

## 0.6.0 — 2026-07-08

### Added

- `VersionUpdateBanner` — a non-blocking prompt that polls a `version.json`
  manifest (on an interval and on tab focus/visibility) and, when the deployed
  build id differs from the one baked into the running bundle, offers a
  user-initiated refresh. Lets a long-open tab recover from version skew (a
  pruned lazy-loaded chunk) without ever forcing a reload.

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
