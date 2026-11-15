import { render, screen } from '@testing-library/react';
import { FormattedMessage } from 'react-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IntlProvider } from './IntlProvider';

const CATALOG = {
  en: { greeting: 'Hello' },
  fr: { greeting: 'Bonjour' },
};

function renderGreeting(locale?: string) {
  render(
    <IntlProvider messagesByLocale={CATALOG} locale={locale}>
      <FormattedMessage id="greeting" />
    </IntlProvider>,
  );
}

describe('IntlProvider locale detection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the leading subtag of navigator.language when a catalog exists for it', () => {
    vi.stubGlobal('navigator', { language: 'fr-CA' });
    renderGreeting();
    expect(screen.getByText('Bonjour')).toBeInTheDocument();
  });

  it('falls back to the default locale when no catalog matches', () => {
    vi.stubGlobal('navigator', { language: 'de-DE' });
    renderGreeting();
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('falls back to the default locale when navigator has no language, as in React Native', () => {
    vi.stubGlobal('navigator', { product: 'ReactNative' });
    renderGreeting();
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('falls back to the default locale when navigator is undefined, as on a server', () => {
    vi.stubGlobal('navigator', undefined);
    renderGreeting();
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('an explicit locale prop wins over navigator.language', () => {
    vi.stubGlobal('navigator', { language: 'en-US' });
    renderGreeting('fr');
    expect(screen.getByText('Bonjour')).toBeInTheDocument();
  });
});
