// ---------------------------------------------------------------------------
// LoadingBlock — a centered, screen-reader-labeled loading indicator.
//
// The standard "this surface is fetching" affordance: a horizontally centered
// MUI CircularProgress with the accessible label baked in (a bare spinner is
// invisible to assistive technology). Extracted because the same flex-centered
// `<Box><CircularProgress aria-label=…/></Box>` block was hand-rolled on ~11
// surfaces in the reference apps; centralizing it guarantees every loading
// state is labeled and visually consistent.
//
// Copy-agnostic: the host app passes an already-localized `label` string.
// ---------------------------------------------------------------------------

import { Box, CircularProgress } from '@mui/material';

export interface LoadingBlockProps {
  /**
   * Accessible label for the spinner (e.g. "Loading records"). Required — a
   * spinner with no label announces nothing to a screen reader. Already
   * localized by the host app.
   */
  readonly label: string;
  /**
   * Vertical padding (MUI spacing units) above and below the spinner.
   * Defaults to 6 — the standard page-section loading inset.
   */
  readonly py?: number;
  /** Spinner diameter in px. Defaults to MUI's 40px. */
  readonly size?: number;
}

/**
 * A centered loading spinner with an accessible label. Use wherever a surface
 * is in its `isPending`/loading state.
 */
export function LoadingBlock({ label, py = 6, size }: LoadingBlockProps): React.JSX.Element {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', py }}>
      <CircularProgress aria-label={label} {...(size === undefined ? {} : { size })} />
    </Box>
  );
}
