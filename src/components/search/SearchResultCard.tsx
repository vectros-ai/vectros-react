// ---------------------------------------------------------------------------
// SearchResultCard — one hit in a hybrid-search results list.
//
// Promoted from `app-vectros-ai`'s `SearchPage.tsx` (its `ResultCard`), the
// SDK-typed result shape (`Awaited<ReturnType<Search['content']>>`'s
// `results[number]`) is identical across reference apps — it's the platform's
// own `search.content()` response, not something an app invents — so the
// layout below (source-type chip, title/link, snippet, similarity badge,
// date) is genuinely app-agnostic. What is NOT promoted, deliberately: routing
// a result to its detail page (each app's own routes), resolving a folder/org
// name from an id (each app's own data), and the query mechanics that produce
// a `SearchResultCardProps` in the first place (each app's own
// `vectrosApiClient` wiring) — those stay app-local. The host resolves a raw
// SDK result item into this component's flat, presentational props.
//
// Copy-agnostic, same convention as LoadingBlock/ApiErrorAlert: the host app
// passes already-localized strings, not message ids.
// ---------------------------------------------------------------------------

import type { ReactNode } from 'react';
import { Box, Card, CardContent, Chip, Link, Stack, Tooltip, Typography } from '@mui/material';
import type { ChipProps } from '@mui/material';

export interface SearchResultCardProps {
  /** The result's display title (from its metadata, or a host-supplied fallback). */
  readonly title: string;
  /** Link target for the title, or `null`/omitted to render plain (non-linked) text —
   *  e.g. a result the host can't resolve a detail route for. */
  readonly href?: string | null;
  /** Rendered in place of a plain `<a>` when `href` is set — pass the host router's
   *  own Link component (e.g. `react-router`'s) so navigation stays client-side. */
  readonly linkComponent?: React.ElementType;
  /** Already-localized label for the source-type chip (e.g. "Document", "Case"). */
  readonly typeLabel: string;
  readonly typeColor?: ChipProps['color'];
  /** Extra chips after the type chip (e.g. a folder or org name). */
  readonly extraChips?: ReactNode;
  /** Matched-text snippet. Render plain text only — never markup (this stays
   *  consistent with a no-untrusted-HTML posture across the reference apps). */
  readonly snippet?: string;
  /** Already-formatted date string (host localizes/formats before passing it in). */
  readonly dateLabel?: string;
  /** Semantic similarity 0-100, or omit/null when the ranking mode carried no
   *  vector leg (a keyword-only search has no similarity score to show). */
  readonly similarityPercent?: number | null;
  /** Already-localized tooltip text for the similarity badge. Only meaningful when
   *  `similarityPercent` is also set; omitting it there renders the badge with an empty
   *  tooltip rather than failing — pass it whenever `similarityPercent` is set. */
  readonly similarityLabel?: string;
  /** A small monospace reference line under the title (e.g. the result's id). */
  readonly idCaption?: string;
}

/** One hybrid-search result: source-type chip, title/link, snippet, similarity, date. */
export function SearchResultCard({
  title,
  href,
  linkComponent,
  typeLabel,
  typeColor = 'primary',
  extraChips,
  snippet,
  dateLabel,
  similarityPercent,
  similarityLabel,
  idCaption,
}: SearchResultCardProps): React.JSX.Element {
  const hasSimilarity = typeof similarityPercent === 'number' && similarityPercent > 0;

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack direction="row" spacing={1} alignItems="flex-start" justifyContent="space-between">
          <Box sx={{ minWidth: 0 }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5, flexWrap: 'wrap' }} useFlexGap>
              <Chip size="small" color={typeColor} variant="outlined" label={typeLabel} />
              {extraChips}
            </Stack>
            {href ? (
              <Link
                {...(linkComponent ? { component: linkComponent } : {})}
                {...(linkComponent ? { to: href } : { href })}
                variant="subtitle1"
                sx={{ fontWeight: 600 }}
              >
                {title}
              </Link>
            ) : (
              <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                {title}
              </Typography>
            )}
            {idCaption && (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: 'block', fontFamily: 'monospace' }}
              >
                {idCaption}
              </Typography>
            )}
          </Box>
          {hasSimilarity && (
            <Tooltip title={similarityLabel ?? ''}>
              <Chip size="small" color="default" label={`${Math.round(similarityPercent)}%`} sx={{ flexShrink: 0 }} />
            </Tooltip>
          )}
        </Stack>

        {snippet && snippet.length > 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {snippet}
          </Typography>
        )}
        {dateLabel && (
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            {dateLabel}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}
