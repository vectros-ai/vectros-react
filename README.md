# @vectros-ai/react

[![npm](https://img.shields.io/npm/v/@vectros-ai/react)](https://www.npmjs.com/package/@vectros-ai/react)
[![license](https://img.shields.io/npm/l/@vectros-ai/react)](https://www.apache.org/licenses/LICENSE-2.0)

The shared React toolkit behind the Vectros reference apps — **admin-app** (control
plane) and **app.vectros.ai** (data plane). It packages the parts both apps need to
look and behave the same without copy-paste:

- **Provider-agnostic auth** — an `AuthProviderAdapter` interface plus a
  `CognitoAuthProvider` reference implementation (sign-in/up, password reset,
  multi-membership, and TOTP MFA). Swap Cognito for Auth0/Clerk/OIDC by
  implementing the adapter; nothing else changes.
- **Vectros API token cache** — short-lived `st_*` bearers minted on demand and
  cached per `(tenant, context)`, with concurrent-mint coalescing and a
  clear-during-mint race guard. The mint function is **injected**, so the
  `/developer/*` call stays inside the swap point.
- **MFA** — a TOTP enrollment wizard and the `/account` 2FA pattern.
- **UI primitives** — `AuthCard`, `PasswordField` (+ strength meter), `AppLayout`
  chrome, `IntlProvider` scaffolding, and the tenant/context switchers.
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

## Status

Pre-1.0. The API may change between minor versions until the first stable release.

## Peer dependencies

The consuming app supplies React 19, MUI 7, Emotion, TanStack Query 5, react-intl,
react-router 7, `aws-amplify`, and `@vectros-ai/sdk` (all `peerDependencies`). The
small leaf utilities (`jose`, `qrcode.react`, `@zxcvbn-ts/*`) ship as regular
dependencies.

## Security & trust

These components reach Vectros with least-privilege scoped keys over a secure, per-customer-isolated
back-end. For the platform's full security and trust posture, see the
[compliance and trust guide](https://docs.vectros.ai/guides/operations-trust/compliance).

## License

Apache-2.0.
