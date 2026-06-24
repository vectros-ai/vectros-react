// ---------------------------------------------------------------------------
// TestIntlProvider — i18n + TanStack Query wrapper for this package's unit tests.
//
// Wraps:
//   1. <IntlProvider> with the package's own base catalog + pinned locale="en",
//      so tests assert against rendered English strings deterministically.
//   2. <QueryClientProvider> with a fresh, test-strict client per render (no
//      retry, no GC/stale refetch) so the cache never leaks across `it()` blocks.
// ---------------------------------------------------------------------------

import { useState } from 'react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { I18N_DEFAULT_LOCALE, IntlProvider } from '../i18n/IntlProvider';
import messagesEn from '../i18n/messages.en.json';

const MESSAGES_BY_LOCALE = { en: messagesEn };

export function TestIntlProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
          mutations: { retry: false },
        },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <IntlProvider messagesByLocale={MESSAGES_BY_LOCALE} locale={I18N_DEFAULT_LOCALE}>
        {children}
      </IntlProvider>
    </QueryClientProvider>
  );
}
