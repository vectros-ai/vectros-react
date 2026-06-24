// ---------------------------------------------------------------------------
// MetaList / MetaRow — a semantic label/value description list.
//
// The "details" card on every entity-detail surface (record, document, schema,
// signed-in identity) renders the same label/value rows. The markup was
// copy-pasted ≥3× (the copies literally carried "mirrors RecordDetailPage's
// MetaRow" comments). Centralizing it here gives every detail surface the same
// responsive layout AND the correct `<dl>`/`<dt>`/`<dd>` semantics in one place.
//
// Presentational and copy-agnostic: labels and values are ReactNode, supplied
// (already localized) by the host app.
// ---------------------------------------------------------------------------

import type { ReactNode } from 'react';
import { Box, Typography } from '@mui/material';

export interface MetaListProps {
  /** A sequence of <MetaRow> elements. */
  readonly children: ReactNode;
}

/** The `<dl>` wrapper for a set of {@link MetaRow}s. */
export function MetaList({ children }: MetaListProps): React.JSX.Element {
  return (
    <Box component="dl" sx={{ m: 0 }}>
      {children}
    </Box>
  );
}

export interface MetaRowProps {
  /** The row's term (rendered as `<dt>`). Already localized. */
  readonly label: ReactNode;
  /** The row's value (rendered as `<dd>`). */
  readonly children: ReactNode;
  /**
   * Width (px) of the label column on `sm`+ viewports. Defaults to 160.
   * On `xs` the row stacks (label above value).
   */
  readonly labelWidth?: number;
}

/**
 * One label/value row inside a {@link MetaList}. Stacks on narrow viewports
 * and lays out as two columns on `sm`+.
 */
export function MetaRow({ label, children, labelWidth = 160 }: MetaRowProps): React.JSX.Element {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: { xs: 'column', sm: 'row' },
        py: 1,
        borderBottom: 1,
        borderColor: 'divider',
        '&:last-child': { borderBottom: 0 },
      }}
    >
      <Typography
        component="dt"
        variant="caption"
        sx={{
          width: { xs: 'auto', sm: labelWidth },
          flexShrink: 0,
          color: 'text.secondary',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          fontWeight: 600,
          py: { xs: 0, sm: 0.5 },
        }}
      >
        {label}
      </Typography>
      <Box component="dd" sx={{ flexGrow: 1, m: 0, minWidth: 0, wordBreak: 'break-word' }}>
        {children}
      </Box>
    </Box>
  );
}
