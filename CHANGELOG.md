# Changelog

All notable changes to `@vectros-ai/react` are documented here.
This project adheres to [Semantic Versioning](https://semver.org).

## 0.12.0 — 2026-09-07

### Added

- **`RecordColumn.inline`** — `deriveValueColumns` now reports the schema's `inline` flag on each
  derived column, alongside the `filterable` flag it already carried. `inline` keeps a field on the
  record row when the payload is stored out of line, so a list read without `includePayload` has a
  value to render; a column derived from a payload-only field has nothing to show for *any* row on
  such a schema, and neither the schema nor the response says why. Reported, not acted on — whether
  to hide the column, render it empty, or read payloads instead is the host's call.

  Note `inline: false` does **not** mean "absent from a payload-less row": `filterable` fields and
  the schema's lookup fields are kept on the row too, and lookup fields are not visible from a
  `FieldDef` at all (`lookupFields` is a sibling collection on the schema). Union this flag with
  `filterable` and your own lookup field ids if you need the whole question answered.

- **`getVectrosResolvedScope(tenantId, contextId?, identityOverride?)`** — reads the resolved scope
  for the same slot `getVectrosApiToken` mints, sharing all of its caching/coalescing/retry
  machinery. `PartnerApiResolvedScope` is exported alongside it.

- **`errorCodeOf(err)`** — reads the machine-readable `errorCode` off a failed call's error
  envelope, alongside the existing `extractRequestId`/`extractErrorMessage`/`statusCodeOf`. The pair
  it exists for is the one a status test cannot resolve: `VERSION_CONFLICT` (your update raced
  another writer — reload and retry) and `RESOURCE_IN_USE` (the resource is still referenced by live
  dependents, so retrying the identical request never succeeds) both arrive as HTTP 409. Returns
  `undefined` when the API named no cause, which is common and is not the same as "no error"; match
  on the value and treat an unrecognised code as unknown rather than assuming your list is
  exhaustive.

### Changed

- **`useScopeGate` no longer decodes the token client-side.** It now reads the mint/exchange/assume
  response's server-resolved `allowedActions`/`identity` (`resolvedScope`) directly — the backend
  resolves them from the exact same plaintext scope data it's about to compress into the token's own
  `scope` claim, so there's nothing left to decode (or drift) on this side. Replaces the old
  client-side JWT decode + a duplicated DEFLATE preset dictionary that had to stay byte-for-byte in
  sync with the platform's own copy.
- **`PartnerApiTokenMinter`/`PartnerApiTokenAssumer`** now carry an optional `resolvedScope` field on
  their resolved value. Both reference providers (`CognitoAuthProvider`, `Auth0AuthProvider`) supply
  it; a fork's own minter that hasn't wired it yet keeps compiling and minting working bearers — it
  just gets an empty scope out of `useScopeGate`/`getVectrosResolvedScope` until it does.

### Removed

- **`__resetScopeGateDecodeCacheForTest`/`__compressScopeClaimForTest`** — both retired along with the
  client-side JWT/compressed-`scope`-claim decode they supported (`scopeCompression.ts`, and its `pako`
  dependency) now that `useScopeGate` reads the plaintext `resolvedScope` field instead. A consuming
  app's test suite building a mint-response fixture should set `resolvedScope` directly rather than
  compressing a token claim. (`decodeAllowedActions`/`decodeIdentity`, the decode functions themselves,
  are also gone, but were never re-exported from this package's public entry point — an internal
  implementation detail, not a public-API removal.)

### Fixed

- **`useScopeGate` can now evaluate the `x` (execute) op letter.** The hook's ops-letter set predated
  `x` — the letter that grants execution of a stored script, as `scripts:x` for every script or
  `scripts:x:<name>` for one — so an ops segment carrying it stopped being recognized as an ops
  string at all, and both the grant and the ask fell out of ops-aware evaluation into the
  exact-string fallback.

  **The breakage was partial.**
  `can('scripts:x')` against a grant spelled exactly `scripts:x` already answered `true` through
  that fallback — the simplest case, and the one you would check first. Every other spelling of the
  same permission answered `false`: a combined grant (`scripts:cx`), ops split across separate
  entries (`scripts:c` + `scripts:x`, asked as `scripts:cx`), and — the sharpest — an ask for an
  UNRELATED letter on a resource whose grant merely mentions `x`, so a credential holding
  `scripts:rx` was told it could not do `scripts:r`. Gating on the compact form now behaves the same
  way for `x` as for every other letter.

  **One divergence from the API is worth planning around**, because it is the shape a per-script
  UI reaches for first: a BARE `scripts:x` grant covers every script, and this gate does not treat
  it as satisfying a per-script ask like `can('scripts:x:daily-report')` — an unqualified grant
  never feeds a qualified ask here, though the API itself would allow the call. Gate a "can execute
  scripts at all" surface on the bare form, and reserve the qualified ask for a credential you
  expect to hold the qualified grant.

- **`isVersionConflict`'s documentation now says where its premise actually holds.** It reported a
  409 as an optimistic-concurrency conflict on the strength of "no other 409 arises on an update
  path", which is true of the record and document updates it exists for and not of the API
  generally: other endpoints answer 409 for resource-state reasons that a reload-and-retry never
  clears, and `PUT /v1/schemas/{id}` became one of them in the 0.43.0 API. Behaviour is unchanged —
  it remains a 409 status test, so nothing that calls it today answers differently — but the
  contract now scopes the claim and points callers at `errorCodeOf` for the cases where the status
  alone does not decide.

## 0.11.0 — 2026-09-01

### Added

- **`SearchResultCard` + `SearchModeToggle`** — presentational primitives for a hybrid-search result
  list. `SearchResultCard` renders one search hit (source-type chip, title/link, snippet, similarity
  badge, date) from flat, presentational props — the host resolves a raw SDK `search.content()` result
  into those props itself, since routing/folder-name resolution stays app-specific. `SearchModeToggle`
  is the Hybrid/Semantic/Keyword ranking-mode control. Both copy-agnostic (host passes already-localized
  strings), same convention as `LoadingBlock`/`ApiErrorAlert`.

### Fixed

- **Fixed duplicate token-exchange calls on a fresh Auth0 sign-in.** A cache-driven token mint no
  longer issues more than one `POST /v1/auth/token/exchange` request when retrying a transient
  failure. A direct `exchangeToken()` call outside the cache (self-signup, invite-accept) is
  unaffected.

## 0.10.0 — 2026-08-30

### Added

- **`ApiErrorAlert` + `RequestIdCaption`**, plus the `extractErrorMessage`/`extractRequestId`/
  `statusCodeOf`/`isVersionConflict` API-error helpers they're built on. A friendly error `Alert`
  (announces via `role="alert"`, MUI's own `Alert` has no implicit one) that surfaces a failed
  call's support-correlation `requestId` as a small reference line, plus the pure, framework-free
  extractors it's built on (duck-typed against the API's uniform error envelope, no SDK error-class
  import needed). Ships with a new `error.requestId` entry in the package's base message catalog
  (`baseMessagesEn`) — a host merging its own catalog over the base gets the reference-line
  copy for free, same pattern the `recordForm.*` catalog entries already use.

- **`AuthErrorCode` gains `USER_ALREADY_EXISTS`**, mapped from Cognito's `UsernameExistsException` in
  `CognitoAuthProvider.signUp`. Previously this fell through to the generic `UNKNOWN` code, which gave
  a host app no way to distinguish "the email you just typed already has an identity" from any other
  signup failure. A host app can now dispatch on this specific code to offer a "sign in instead"
  recovery path rather than a dead-end generic error. Every consuming app's own `auth.errors.*` message
  catalog needs its own `USER_ALREADY_EXISTS` entry to translate it — the shared `authErrorToMessage`
  translator falls back to react-intl's own missing-message handling otherwise.

## 0.9.0 — 2026-08-27

### Added

- **Identity-override token axis** (`vectrosApiTokenCache`) — a (tenant, context) partner-API bearer's
  `identity.<namespace>` picks one default value; a caller admitted to more than one (a multi-org
  practitioner choosing which org to act as) can now get a bearer with a single namespace switched to
  a different admitted value via `getVectrosApiToken`'s optional third argument
  (`{ namespace: 'scope:org', value: 'orgB' }`), backed by `POST /v1/auth/token/assume`. Cached in its
  own slot per (tenant, context, namespace, value) — resolving it first resolves and shares the base
  bearer's own cache/coalescing, so switching back and forth between two orgs re-uses both cached
  bearers rather than re-exchanging every time. A host app wires the exchange call via the new
  `setPartnerApiTokenAssumer(assumer: PartnerApiTokenAssumer)`, mirroring `setPartnerApiTokenMinter`'s
  injection shape; omit it entirely for a tenant/context-only app and the override branch is never
  reached.

- **Schema-driven record UI** (`schema-ui`) — a schema's `FieldDef[]` + `renderHints` drive typed
  form inputs and derived table columns generically, so a host app builds its own record
  editor/list page around these primitives instead of hand-rolling one per record type:
  - **`RecordFormFields`** — renders a typed input per schema field (string/number/boolean/date/enum),
    reporting edits via `onChange`; complex types and schema-undescribed payload keys are listed as a
    raw-view hint rather than silently dropped. Ships default English strings for its own copy
    (`recordForm.*` in `baseMessagesEn`).
  - **`schemasForSurface`/`distinctTypes`** — filter a schema list down to the types that bind to a
    given surface (`record`/`document`) and collapse to one entry per distinct `typeName`.
  - **Form helpers** — `fieldLabel`/`fieldHelpText`/`fieldWidget`/`orderedFormFields`/
    `groupFieldsBySection`/`temporalInputKind`/`coerceFieldValue`/`validateFields`/`withField`/
    `isReservedPayloadKey`/`stripReservedPayloadKeys` and their supporting types (`RenderHints`,
    `FieldErrors`, `FieldSection`).
  - **List-column helpers** — `deriveValueColumns`/`findDisplayFieldId`/`filterableFieldIds`/
    `formatCellValue`/`compareValues`/`sortRecords`/`payloadMatchesQuery`.

  Types re-source directly from `@vectros-ai/sdk`'s `Vectros` namespace rather than a host app's own
  API wrapper — no new dependency category (the package already declared `@mui/material`/
  `@mui/icons-material` as peer deps).

- **Streaming inference state** (`useInferenceStream`/`reduceInferenceEvent`) — folds the SSE
  event stream any of the three inference endpoints (`chat`/`rag`/`documentAsk`) return into one flat
  render state (`InferenceStreamState`) via a pure, independently-testable reducer
  (`reduceInferenceEvent`) plus a thin React hook (`useInferenceStream`) that drives the async
  iteration, handles cancellation (abort + a stale-run guard so a cancelled stream's late events
  never apply), and exposes `run`/`cancel`/`reset`. Endpoint-agnostic — the caller supplies the SDK
  call as a runner thunk, so the same hook serves chat, RAG, and document-ask alike.

- **Repinned to `@vectros-ai/sdk` 0.41.0.** No API surface this package uses changed shape; see the
  [SDK changelog](https://github.com/vectros-ai/sdk/blob/main/CHANGELOG.md) for the full release.

### Changed — breaking

- **`HostedRedirectAuth` gains a third required method, `acceptInvite(inviteToken)`** — alongside the
  existing `signInWithRedirect`/`handleRedirectCallback`. Backed by `Auth0AuthProvider.exchangeToken({
  inviteToken })`: call it once, from your app's own accept-invite route, right after
  `handleRedirectCallback()` has established a session — it performs the server-side bind that
  transitions a first-time signer from PENDING to ACTIVE.

  **Migration for a `HostedRedirectAuth` implementer:** add an `acceptInvite(inviteToken: string):
  Promise<void>` method that presents the invite token to your own token-exchange endpoint (see
  `Auth0AuthProvider.exchangeToken`'s `inviteToken` option for the reference shape). An app that never
  routes an invite-accept flow through `useAuth()` can implement it as a no-op or a rejected promise.

### Fixed

- **`Auth0AuthProvider.exchangeToken` now retries once on a `403`.** A first-time sign-in could
  occasionally fail immediately with a hard, unrecoverable error even though the account was
  valid, caused by a benign server-side race on a brand-new identity's very first token exchange.
  The client now retries once after a short delay, which resolves the race silently; any other
  cause of a `403` still fails as before. The retry is skipped when `inviteToken` is set, since an
  invite-accept exchange never hits this race.

- **`Auth0AuthProvider.exchangeToken` now presents the access token, not the ID token.** Token
  exchange was failing for every Auth0-based sign-in: the client was presenting the ID token,
  whose `aud` claim can never match the audience the exchange endpoint requires. It now presents
  the access token, which carries the right audience.

- **Fixed a bug where a token mint attempted before `setPartnerApiTokenMinter` had registered a
  minter could permanently break all later token requests for that (tenant, context).** Every
  subsequent caller would hang forever instead of getting a token, even after a minter registered
  correctly moments later. This was reachable in normal use — for example a gated nav item
  mounting before app boot finished registering the minter — not just a theoretical edge case.

- **`useScopeGate`/`RequireScope` now correctly resolve permissions from a compressed `scope` claim.**
  The platform mints the `st_*` token's `scope` claim DEFLATE-compressed against a shared preset
  dictionary rather than as a plain JSON object; the decode here now decompresses it before reading
  `allowed_actions`/`identity`, so gated routes and nav items render for the permissions a session
  actually holds. A plain-object `scope` claim still decodes, unchanged. Adds `pako` as a runtime
  dependency (not a peer).

- **`ScopeGate`/`RequireScope`/`AppLayout` gain an optional tenant override, for a single-tenant host
  with no `CurrentTenantProvider` in its tree** (`ScopeGateProps.tenantOverride` /
  `RequireScopeProps.tenantOverride` / `AppLayoutProps.scopeGateTenant`, the last threading down into
  every gated nav item's own `ScopeGate`). Without a `CurrentTenantProvider`, a gated nav item or
  route would silently never resolve — no content, no redirect, no error. Supplying a stable,
  app-wide tenant-key string fixes this; a single-tenant exchange-based auth provider ignores the
  value entirely (it exists only as a cache key), so any non-empty constant works. Fully backward
  compatible — omitting the new props preserves the existing multi-tenant behavior unchanged.

- **`canPerform` now recognizes a combined-ops grant for a qualified action ask.** A caller holding
  a combined grant like `records:crud:case` was incorrectly denied a qualified ask like
  `records:r:case`, hiding gated nav items/routes the token actually authorized. Fixed; an
  unqualified grant still never satisfies a qualified ask, and a qualified grant still never leaks
  into a different qualifier.
- **Auth0's unverified-email login rejection now maps to a real `AuthErrorCode` instead of `UNKNOWN`.**
  A database-connection login requiring email verification previously showed a generic "something
  went wrong" with no indication a verification email had been sent. Adds a new
  `EMAIL_NOT_VERIFIED` code, kept deliberately separate from the Cognito-shaped `USER_NOT_CONFIRMED`
  (which expects a code, not a link).
- **Fixed several redundant `/token/exchange` calls firing for one page load after a failed token
  mint right after invite-accept.** Independent `useScopeGate` consumers mounting around the same
  moment (separate nav items) each raced a fresh mint instead of joining a single retry. The
  one-shot delayed retry now lives inside the shared cache slot, so every caller arriving during
  the attempt/delay/retry window shares it.

## 0.8.0 — 2026-08-19

### Added

- **`Auth0AuthProvider`** — a second `AuthProviderAdapter` reference implementation, backed by Auth0
  Universal Login (`@auth0/auth0-spa-js`, now an optional peer dependency). Implements the core
  adapter plus the new `HostedRedirectAuth` interface (`signInWithRedirect`/`handleRedirectCallback`)
  — Auth0's hosted pages own the entire sign-in/signup/password/MFA ceremony under Universal Login, so
  this provider deliberately does not implement `EmbeddedCredentialAuth` or `VectrosTenancyProvider`
  (see below). Also exposes `exchangeToken`/`mintPartnerApiToken`, wiring the RFC 8693 token-exchange
  endpoint as the app's `PartnerApiTokenMinter`, the same seam `CognitoAuthProvider.mintPartnerApiToken`
  already uses.

### Changed — breaking

- **`AuthProviderAdapter` is now the minimal core (`getCurrentUser`/`signOut`/`getIdToken`) every
  provider implements unconditionally.** The rest of the old, single 22-method interface is split
  across three new, purpose-named interfaces along two independent axes, not left as one flat pile of
  optional methods:
  - **`EmbeddedCredentialAuth`** — `signIn`/`confirmSignIn`/`signUp`/`confirmSignUp`/`resendSignUpCode`/
    `forgotPassword`/`confirmForgotPassword`/`changePassword`/`getMfaStatus`/`setUpTotp`/
    `verifyTotpSetup`/`disableTotp`. A provider implements this only when it lets the app drive the
    whole credential ceremony itself — `CognitoAuthProvider` still does, in full.
  - **`HostedRedirectAuth`** (new) — `signInWithRedirect`/`handleRedirectCallback`, for providers whose
    own hosted page owns the ceremony end to end.
  - **`VectrosTenancyProvider`** — `getMemberships`/`getActiveTenant`/`getActivePartnerUserId`/
    `setActiveTenant`/`checkUserExists`/`linkInvitation`/`listAppContexts`. Vectros's own multi-tenant
    developer-portal model — structurally inapplicable to any token-exchange-based provider (one
    registered issuer pins exactly one tenant, permanently), so it's no longer part of the generic,
    provider-agnostic contract at all.

  `useAuth()`'s `AuthContextValue` mirrors this: every `EmbeddedCredentialAuth`/`HostedRedirectAuth`
  method is now **optional**, present only when the concrete provider implements it (`<AuthProvider>`
  detects this at construction). The multi-tenancy methods are **removed from `useAuth()` entirely** —
  `CurrentTenantProvider` now takes the tenancy-capable provider as an explicit new `tenancyProvider`
  prop instead, and itself exposes `getActivePartnerUserId`/`listAppContexts`/`checkUserExists`/
  `linkInvitation` via `useCurrentTenant()` for descendants that need them (e.g. a data-plane context
  switcher) without going through `useAuth()`.

  **Migration for an existing Cognito-only consumer:** pass the same adapter instance to both
  `<AuthProvider provider={cognitoProvider}>` and `<CurrentTenantProvider tenancyProvider={cognitoProvider}>`.
  If your app always uses one provider shape, narrow `useAuth()`'s return type once in your own local
  wrapper — using the new exported `assertEmbeddedAuth`/`assertHostedAuth` type-assertion functions,
  which back the narrowing with a real runtime check rather than a bare cast, so a future provider swap
  fails loudly at the first `useAuth()` call instead of compiling clean and throwing deep inside some
  page (see `admin-app`'s `src/auth/index.ts` for the pattern) — rather than optional-chaining every
  call site.

- **`aws-amplify` is now an optional peer dependency** (was required) — an Auth0-only consumer no
  longer needs to install it. `@auth0/auth0-spa-js` is added as a second optional peer dependency,
  needed only by consumers constructing `Auth0AuthProvider`.

### Changed

- Updated the `@vectros-ai/sdk` version the toolkit is built and tested against to **0.40.0**. No
  functional changes; the peer-dependency range (`>=0.9.0`) is unchanged.
- **`Auth0AuthProvider.exchangeToken`/`mintPartnerApiToken` now forward an optional `contextId`** on
  `POST /v1/auth/token/exchange` as `context_id`. Relevant only when your registered issuer serves more
  than one app context (each via its own `POST /v1/auth/issuers` row and audience) — omit it when your
  issuer serves exactly one, the common case, unaffected by this addition. `mintPartnerApiToken` already
  accepted a `contextId` argument per the shared `PartnerApiTokenMinter` signature; it previously
  discarded it, now it's forwarded.

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
