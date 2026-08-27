# @vectros-ai/react

[![npm](https://img.shields.io/npm/v/@vectros-ai/react)](https://www.npmjs.com/package/@vectros-ai/react)
[![license](https://img.shields.io/npm/l/@vectros-ai/react)](https://www.apache.org/licenses/LICENSE-2.0)

The shared React toolkit behind the Vectros reference apps — **admin-app** (control
plane) and **app.vectros.ai** (data plane). It packages the parts both apps need to
look and behave the same without copy-paste:

- **Provider-agnostic auth** — a minimal `AuthProviderAdapter` core plus purpose-named extension
  interfaces a provider implements only where they genuinely apply: `EmbeddedCredentialAuth`
  (sign-in/up, password reset, TOTP MFA — driven by the app itself) for a provider like Cognito, or
  `HostedRedirectAuth` for a provider whose own hosted page owns the whole ceremony. Ships two
  reference implementations: `CognitoAuthProvider` (embedded) and `Auth0AuthProvider` (Auth0
  Universal Login, hosted-redirect). Write your own by implementing the interfaces that fit your
  provider's actual integration mode — see each interface's doc comment for which is which.
- **Vectros API token cache** — short-lived `st_*` bearers minted on demand and
  cached per `(tenant, context)`, with concurrent-mint coalescing and a
  clear-during-mint race guard. The mint function is **injected**
  (`setPartnerApiTokenMinter`), so the `/developer/*` call stays inside the
  swap point. Optionally also register `setPartnerApiTokenAssumer` and pass a
  third `{ namespace: 'scope:<ns>', value }` argument to `getVectrosApiToken`
  to get back a bearer with that identity namespace assumed to a different
  admitted value (`POST /v1/auth/token/assume`, for a multi-org practitioner
  choosing which org to act as) — cached in its own slot, separate from the
  base bearer. Omit the assumer entirely for a tenant/context-only app
  (admin-app's shape); the override branch is then simply never reached.
- **MFA** — a TOTP enrollment wizard and the `/account` 2FA pattern.
- **UI primitives** — `AuthCard`, `PasswordField` (+ strength meter), `AppLayout`
  chrome, `IntlProvider` scaffolding, and the tenant/context switchers.
- **Schema-driven record UI** — `RecordFormFields` renders a typed input per schema field
  (string/number/boolean/date/enum) from a `FieldDef[]` + `renderHints`, and
  `deriveValueColumns`/`sortRecords`/`payloadMatchesQuery` derive a records-list table (columns,
  client-side sort, free-text filter) from the same schema shape — build a record editor/list page
  around these instead of hand-rolling one per record type.
- **Version-update banner** — `VersionUpdateBanner` polls a `version.json`
  manifest and offers a user-initiated refresh when a newer build is deployed,
  so a long-open tab never strands on a stale shell.

## Install

```bash
npm install @vectros-ai/react
```

This is a toolkit for an existing app, so it expects a set of peer
dependencies the app already provides (React, MUI, TanStack Query, the
Vectros SDK, and more) — see [Peer dependencies](#peer-dependencies) below.

**`CognitoAuthProvider` and `Auth0AuthProvider` are each their own subpath
import, not part of the main barrel** — only their *types* are exported from
`@vectros-ai/react` itself, so each SDK's runtime only enters your bundle
when you actually import that provider:

```ts
import { AuthProvider, CurrentTenantProvider } from '@vectros-ai/react';
import { CognitoAuthProvider } from '@vectros-ai/react/providers/cognito';
// or: import { Auth0AuthProvider } from '@vectros-ai/react/providers/auth0';
```

## Status

Pre-1.0. The API may change between minor versions until the first stable release.

## Peer dependencies

The consuming app supplies React 19, MUI 7, Emotion, TanStack Query 5, react-intl,
react-router 7, and `@vectros-ai/sdk` (all required `peerDependencies`). `aws-amplify`
and `@auth0/auth0-spa-js` are **optional** peer dependencies — install whichever
matches the provider you actually use (`CognitoAuthProvider` needs `aws-amplify`;
`Auth0AuthProvider` needs `@auth0/auth0-spa-js`); neither is required if you write
your own adapter against a different provider. The small leaf utilities (`jose`,
`qrcode.react`, `@zxcvbn-ts/*`) ship as regular dependencies.

## Security & trust

These components reach Vectros with least-privilege scoped keys over a secure, per-customer-isolated
back-end. For the platform's full security and trust posture, see the
[compliance and trust guide](https://docs.vectros.ai/guides/operations-trust/compliance).

## License

Apache-2.0.
