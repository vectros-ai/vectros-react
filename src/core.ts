// ---------------------------------------------------------------------------
// @vectros-ai/react/core: the headless entry.
//
// Everything here runs without a DOM: auth state and hooks, tenant and scope
// gates, the Vectros API token cache, the streaming inference state, the
// schema-driven form and column logic, API error helpers and the react-intl
// wrapper. Nothing reachable from this file imports MUI, Emotion, react-dom or
// react-router, so a React Native (Expo) app or a server-rendered web app can
// import it with only `react`, `react-intl`, `@tanstack/react-query` and
// `@vectros-ai/sdk` installed.
//
// The root entry (`@vectros-ai/react`) re-exports all of this plus the MUI
// components. Import from `/core` whenever the web UI kit is not installed;
// importing the root without it fails to bundle (Metro: "Unable to resolve
// module").
//
// packageExports.test.ts walks this file's import graph and fails if any module
// it reaches imports a browser-only or web-UI package, so keep that list in
// step when adding an export here.
// ---------------------------------------------------------------------------

import baseMessages from './i18n/messages.en.json';

export * from './auth';

export {
  errorCodeOf,
  extractErrorMessage,
  extractRequestId,
  isVersionConflict,
  statusCodeOf,
} from './lib/apiError';

export * from './inference';

// The token exchange itself, for an app whose identity provider has no
// authorization-code flow (Firebase Authentication, for example): sign in with
// that provider's SDK, then mint with
//   setPartnerApiTokenMinter(async () => exchangeSubjectToken(endpoint, await getIdToken(), { skipOwnRetry: true }))
// and call clearVectrosApiTokenCache() on every auth-state change of that SDK,
// so a new user is never served the previous user's cached bearer.
export { exchangeSubjectToken } from './auth/providers/tokenExchange';
export type { ExchangedToken, TokenExchangeOptions } from './auth/providers/tokenExchange';

export * from './schema-ui/headless';

export { IntlProvider, I18N_DEFAULT_LOCALE } from './i18n/IntlProvider';
export type { IntlProviderProps, MessagesByLocale } from './i18n/IntlProvider';

/**
 * The package's default English strings for its own components. Merge your
 * app's catalog over it (`{ ...baseMessagesEn, ...appMessagesEn }`); your keys
 * win on collision.
 */
export const baseMessagesEn: Readonly<Record<string, string>> = baseMessages;
