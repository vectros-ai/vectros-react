// ---------------------------------------------------------------------------
// IntlProvider — react-intl wrapper for the Vectros reference apps.
//
// A thin, catalog-agnostic seam over react-intl's IntlProvider:
//   - The host app supplies its message catalog(s) via `messagesByLocale`
//     (the library is brand- and copy-agnostic). A typical app passes
//     `{ en: { ...vectrosReactMessagesEn, ...appMessagesEn } }`.
//   - Browser locale detection: navigator.language → leading subtag → a
//     shipped catalog OR the default-locale fallback. Defensive against
//     locales the app doesn't ship.
//   - Default locale = English (overridable). react-intl uses defaultLocale
//     only for pluralization-rule fallback; missing-message fallback is via
//     the `defaultMessage` prop on FormattedMessage.
//
// Why a wrapper instead of using react-intl's IntlProvider directly:
//   1. Centralized locale detection (browser → catalog match → fallback).
//   2. A stable seam for tests + Storybook — they import the same component.
//
// NOT i18n-wrapped: the app's ErrorBoundary copy (intentionally lives outside
// this provider so the boundary can render even if react-intl fails to mount).
// ---------------------------------------------------------------------------

import type { ReactNode } from 'react';
import { IntlProvider as ReactIntlProvider } from 'react-intl';

/** The locale assumed when none is detected/shipped. */
export const I18N_DEFAULT_LOCALE = 'en';

/** A locale → (message-id → string) catalog registry. */
export type MessagesByLocale = Readonly<Record<string, Record<string, string>>>;

export interface IntlProviderProps {
  readonly children: ReactNode;
  /**
   * The app's catalog registry, keyed by BCP-47 leading subtag (e.g. `en`).
   * The library renders only the locales the app ships.
   */
  readonly messagesByLocale: MessagesByLocale;
  /** Fallback locale + pluralization base. Defaults to `en`. */
  readonly defaultLocale?: string;
  /**
   * Optional locale override — primarily for tests and Storybook. In normal
   * runtime, omit this and the provider picks up the browser locale. (Explicit
   * `| undefined` so a host wrapper can forward an optional prop directly under
   * exactOptionalPropertyTypes.)
   */
  readonly locale?: string | undefined;
}

/**
 * Detect the active locale: the leading subtag of `navigator.language`
 * (`en-US` → `en`) if the app ships a catalog for it, else `defaultLocale`.
 * SSR-safe: `navigator` is undefined in Node → returns `defaultLocale`.
 */
function detectLocale(messagesByLocale: MessagesByLocale, defaultLocale: string): string {
  if (typeof navigator === 'undefined') {
    return defaultLocale;
  }
  const language = navigator.language.split('-')[0] ?? defaultLocale;
  return language in messagesByLocale ? language : defaultLocale;
}

/**
 * Wrap children in react-intl's provider with the resolved locale + the app's
 * catalog. Renders once per mount; StrictMode's double-invoke is fine because
 * `detectLocale()` is pure.
 */
export function IntlProvider({
  children,
  messagesByLocale,
  defaultLocale = I18N_DEFAULT_LOCALE,
  locale,
}: IntlProviderProps): React.JSX.Element {
  const activeLocale = locale ?? detectLocale(messagesByLocale, defaultLocale);
  const messages =
    messagesByLocale[activeLocale] ?? messagesByLocale[defaultLocale] ?? {};
  return (
    <ReactIntlProvider locale={activeLocale} defaultLocale={defaultLocale} messages={messages}>
      {children}
    </ReactIntlProvider>
  );
}
