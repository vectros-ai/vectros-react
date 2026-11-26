# @vectros-ai/react

[![npm](https://img.shields.io/npm/v/@vectros-ai/react)](https://www.npmjs.com/package/@vectros-ai/react)
[![license](https://img.shields.io/npm/l/@vectros-ai/react)](https://www.apache.org/licenses/LICENSE-2.0)

The shared React toolkit behind the Vectros reference apps — **admin-app** (control
plane), **app.vectros.ai** (data plane) and **casework-spa**. It packages the parts those apps share
so they look and behave the same without copy-paste:

- **Provider-agnostic auth** — a minimal `AuthProviderAdapter` core plus purpose-named extension
  interfaces a provider implements only where they genuinely apply: `EmbeddedCredentialAuth`
  (sign-in/up, password reset, TOTP MFA — driven by the app itself) for a provider like Cognito, or
  `HostedRedirectAuth` for a provider whose own hosted page owns the whole ceremony. Ships three
  reference implementations: `CognitoAuthProvider` (embedded), `Auth0AuthProvider` (Auth0
  Universal Login, hosted-redirect) and `ExpoAuthProvider` (any OpenID Connect provider from a
  React Native / Expo app, hosted-redirect). Write your own by implementing the interfaces that fit your
  provider's actual integration mode — see each interface's doc comment for which is which.
- **Vectros API token cache** — short-lived `st_*` bearers minted on demand and
  cached per `(tenant, context)`, with concurrent-mint coalescing and a
  clear-during-mint race guard. The mint function is **injected**
  (`setPartnerApiTokenMinter`), so the token-minting call stays inside the
  swap point. Optionally also register `setPartnerApiTokenAssumer` and pass a
  third `{ namespace: 'scope:<ns>', value }` argument to `getVectrosApiToken`
  to get back a bearer with that identity namespace assumed to a different
  admitted value (`POST /v1/auth/token/assume`, for a multi-org practitioner
  choosing which org to act as) — cached in its own slot, separate from the
  base bearer. Omit the assumer entirely for a tenant/context-only app
  (admin-app's shape); the override branch is then simply never reached.
  `getVectrosResolvedScope` reads the server-resolved `allowedActions`/`identity` for the same slot,
  sharing the cache's coalescing and retry — which is what `useScopeGate` gates on, rather than
  decoding the token in the browser.
- **MFA** — a TOTP enrollment wizard (`TotpEnrollmentWizard`); the account page that hosts it is yours to build.
- **UI primitives** — `AuthCard`, `PasswordField` (+ strength meter), `AppLayout`
  chrome, and `IntlProvider` scaffolding. No tenant or context switcher component ships: `AppLayout`
  renders whatever node you pass as its `switcher` prop in the app bar (when signed in), and
  `CurrentTenantProvider` with the `useCurrentTenant` hook hold the memberships and the active tenant
  such a switcher reads and changes. The app bar also takes `appBarStart`, a node rendered on its left
  (an app name, a breadcrumb or a page title), and `appBarDense`, which shortens the bar from 64px to 48px.
- **API-error handling** — `ApiErrorAlert` (renders a Vectros API error consistently, including its
  request id) and `RequestIdCaption`, plus the `extractErrorMessage`/`extractRequestId`/
  `statusCodeOf`/`isVersionConflict`/`errorCodeOf` helpers they're built on — pull an error's
  message, request id, HTTP status, an HTTP 409 test, or the API's own machine-readable `errorCode`
  out of any Vectros SDK error without hand-rolling the same extraction per app. `isVersionConflict`
  is a status test only: it is true for any 409. On a record or document update a 409 means the item
  changed while your update was in flight, whether or not you sent `expectedVersion`; other routes answer
  409 for other reasons, such as deleting a schema that records, documents, users or entities still use. `errorCodeOf` is what separates two causes a status test
  cannot: `VERSION_CONFLICT` (reload and retry) and `RESOURCE_IN_USE` (retrying the identical request
  never succeeds) both arrive as HTTP 409.
- **Streaming inference state** — `useInferenceStream` runs a chat, RAG or document-ask stream and folds
  it into render state (`state.text`, `state.citations`, `state.usage`, `state.status`), with `run`,
  `cancel` and `reset`. You pass the SDK call as a runner, for example
  `run(({ abortSignal }) => client.inference.ragInference(request, { abortSignal }))`. When a run fails,
  `state.status` is `'error'` and `state.error` is an object of the exported type `InferenceStreamError`:
  - `message` and `code` are always set. For an `error` event in the stream, they are that event's own
    message and code. For an error thrown by the runner or while the stream is read, `code` is
    `'stream_error'` and `message` is the thrown error's message — for an SDK error, the SDK's multi-line
    text with the status and response body in it, so do not show it to end users as is — or
    `'Inference stream failed.'` when what was thrown is not an `Error`. If a run produces both an `error`
    event and a thrown error, the later one replaces the earlier.
  - `status` is the HTTP status of the thrown error, when it carries one, whatever the status: a request
    the API refused before the stream started (400, 403, 404, 409, 429 and so on) or a server error
    (5xx). It does not mean nothing was streamed, because an error thrown while the stream is being read
    keeps the text received so far in `state.text`. It is `undefined` for a stream `error` event and for
    a failure with no response, such as a network error.
  - `errorCode` is the API's own machine-readable code from the error response (for example
    `RATE_LIMITED`), when the response names one. Many 4xx responses carry only a message, so
    `undefined` means the API did not name a cause. Treat an unrecognised value as unknown.
  - `detail` is the API's own client-facing message from the error response (for example "Your pre-paid
    inference balance is busy with other concurrent requests. This is not a shortage: retry in a moment."),
    without the SDK's wrapper text. It is `undefined` for a stream `error` event and when the response
    carries no message. When `status` is set, show `detail` rather than `message`, and your own line
    naming the status when `detail` is `undefined`.

  Together, `status`, `errorCode` and `detail` let you choose your own copy without wrapping the runner.
- **Public reads** — `createPublicClient({ key: 'pub_...' })` from `@vectros-ai/react/public` reads an app context's public records
  anonymously: `get(type, publicId)`, `list(type, { by: { city: 'Lisbon' } })` (one published lookup field; pass
  `nextCursor` back as `cursor`), `listAll(...)` (every page, as an async iterable) and `search(type, { q, mode, near, filters, sortBy, order })`.
  It takes only a publishable key and refuses an `sk_`, `ssk_` or `st_` credential; a server key (`pubs_...`) needs its
  `serverSecret`, is refused in a browser page, a Web Worker or a React Native app, and sends its secret only to an
  `https:` base URL (plain `http:` only to localhost). Failed reads throw the SDK's errors (read them with
  `statusCodeOf` and `errorCodeOf`). `usePublicRecord` and `usePublicList` wrap it in TanStack Query. It is its own
  entry because it is the one part of this package that loads `@vectros-ai/sdk` at runtime: `/core` stays type-only on
  the SDK. The package's `@vectros-ai/sdk` peer range stays `>=0.9.0`, so installing it does not force an SDK
  upgrade; `/public` itself needs 0.50.0 or later, checked when `createPublicClient` is called (it throws on an older SDK).
- **Schema-driven record UI** — `RecordFormFields` renders a typed input per schema field
  (string/number/boolean/date/enum) from a `FieldDef[]` + `renderHints`, and
  `deriveValueColumns`/`sortRecords`/`payloadMatchesQuery` derive a records-list table (columns,
  client-side sort, free-text filter) from the same schema shape — build a record editor/list page
  around these instead of hand-rolling one per record type.
- **Version-update banner** — `VersionUpdateBanner` polls a `version.json`
  manifest and offers a user-initiated refresh when a newer build is deployed,
  so a long-open tab never strands on a stale shell.
- **Hybrid search UI** — `SearchResultCard` (one hybrid-search hit: source-type chip, title/link,
  snippet, similarity badge, date — the host resolves a raw SDK `search.content()` result into
  its flat props; the title links only for an `http(s):` / `mailto:` URL, an in-page `#fragment`,
  or a rooted path such as `/cases/1`, and is plain text for any other `href`) and
  `SearchModeToggle` (the Hybrid/Semantic/Keyword ranking-mode control).

## Install

```bash
npm install @vectros-ai/react
# A web app also installs the web UI peers (optional peers, so npm does not add them for you):
npm install react-dom @mui/material @mui/icons-material @emotion/react @emotion/styled react-router
```

This is a toolkit for an existing app, so it expects a set of peer
dependencies the app already provides (React, MUI, TanStack Query, the
Vectros SDK, and more) — see [Peer dependencies](#peer-dependencies) below.

**`CognitoAuthProvider`, `Auth0AuthProvider` and `ExpoAuthProvider` are each their own subpath
import, not part of the main barrel** — only their *types* are exported from
`@vectros-ai/react` itself, so each SDK's runtime only enters your bundle
when you actually import that provider:

```ts
import { AuthProvider, CurrentTenantProvider } from '@vectros-ai/react';
import { CognitoAuthProvider } from '@vectros-ai/react/providers/cognito';
// or: import { Auth0AuthProvider } from '@vectros-ai/react/providers/auth0';
```

### React Native (Expo)

Import the headless entry, `@vectros-ai/react/core`, and the Expo provider. `/core` holds everything that does
not render MUI: auth state and hooks, tenant and scope gates, the token cache, the streaming inference hook, the
schema form logic, the API error helpers and `IntlProvider`. It needs only `react`, `react-intl`,
`@tanstack/react-query` and `@vectros-ai/sdk`. The root entry needs the web UI kit, so a React Native app must
not import it. Package `exports` resolution is required: Expo SDK 53 or later (React Native 0.79 or later).

```ts
import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import { AuthProvider, getVectrosApiToken, setPartnerApiTokenMinter } from '@vectros-ai/react/core';
import { ExpoAuthProvider } from '@vectros-ai/react/providers/expo';

const auth = new ExpoAuthProvider({
  issuer: 'https://idp.example.com',
  clientId: 'your-public-client-id',
  redirectUri: AuthSession.makeRedirectUri({ scheme: 'org.example.app' }),
  subjectToken: 'id_token',
  exchangeEndpoint: 'https://api.vectros.ai/v1/auth/token/exchange',
  authSession: AuthSession,
  secureStore: SecureStore,
});
setPartnerApiTokenMinter((tenantId, contextId) => auth.mintPartnerApiToken(tenantId, contextId));
```

`ExpoAuthProvider` signs in through the system browser with PKCE, keeps the identity provider's refresh token in
`expo-secure-store` and every other token in memory, and exchanges the provider's token for a Vectros `st_*`. The
Expo modules are passed in, so this package depends on neither Expo nor React Native: `expo-auth-session` and
`expo-secure-store` are the app's own dependencies. The identity provider must offer the authorization-code flow
with PKCE to a public client; for one that does not (Firebase Authentication), sign in with its SDK and mint with
`exchangeSubjectToken` from `/core`. The full guide, including which token each identity provider needs and the
app-store checklist, is [Mobile apps](https://docs.vectros.ai/guides/clients/mobile).

## Status

Pre-1.0. The API may change between minor versions until the first stable release.

## Peer dependencies

The consuming app supplies React 19 or later, TanStack Query 5 or later, react-intl 10 or later and
`@vectros-ai/sdk` 0.9.0 or later (required `peerDependencies`; the ranges have no upper bound). The web
UI kit is an **optional** set of peers that the root entry needs and `/core` does not: React DOM 19 or
later, MUI (`@mui/material` and `@mui/icons-material`) 7 or later, Emotion (`@emotion/react` and
`@emotion/styled`) 11.14 or later and react-router 7 or later. Because they are optional, npm does not
install them for you: a web app installs them itself. `aws-amplify`
and `@auth0/auth0-spa-js` are **optional** peer dependencies — install whichever
matches the provider you actually use (`CognitoAuthProvider` needs `aws-amplify`;
`Auth0AuthProvider` needs `@auth0/auth0-spa-js`); neither is required if you write
your own adapter against a different provider. The small leaf utilities (`jose`,
`qrcode.react`, `@zxcvbn-ts/*`) ship as regular dependencies.

## Security & trust

These components reach Vectros with short-lived, least-privilege scoped tokens over a secure, per-customer-isolated
back-end. For the platform's full security and trust posture, see the
[compliance and trust guide](https://docs.vectros.ai/guides/operations-trust/compliance).

## License

Apache-2.0.
