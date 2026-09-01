// ---------------------------------------------------------------------------
// SearchModeToggle — the Hybrid/Semantic/Keyword ranking-mode control shared
// by every reference app's hybrid-search screen.
//
// Pure presentation: the three modes map 1:1 to the Vectros search API's own
// `mode` parameter, so there is no app-specific logic to abstract away — only
// the MUI ToggleButtonGroup markup, hand-duplicated once already
// (`app-vectros-ai`'s `SearchPage.tsx`, `casework-spa`'s own port of it).
//
// Copy-agnostic, same convention as LoadingBlock/ApiErrorAlert: the host app
// passes already-localized labels, not message ids.
// ---------------------------------------------------------------------------

import { ToggleButton, ToggleButtonGroup } from '@mui/material';

/** Ranking mode — mirrors the SDK's `search.content({ mode })` parameter. */
export type SearchMode = 'HYBRID' | 'SEMANTIC' | 'TEXT';

export interface SearchModeToggleProps {
  readonly value: SearchMode;
  readonly onChange: (next: SearchMode) => void;
  /** Already-localized labels for the three modes. */
  readonly labels: {
    readonly hybrid: string;
    readonly semantic: string;
    readonly keyword: string;
  };
  /** Already-localized accessible label for the group (e.g. "Ranking mode"). */
  readonly ariaLabel: string;
  readonly disabled?: boolean;
}

/** The Hybrid/Semantic/Keyword ranking-mode toggle for a hybrid-search screen. */
export function SearchModeToggle({
  value,
  onChange,
  labels,
  ariaLabel,
  disabled,
}: SearchModeToggleProps): React.JSX.Element {
  return (
    <ToggleButtonGroup
      value={value}
      exclusive
      size="small"
      disabled={disabled}
      onChange={(_e, next: SearchMode | null) => {
        if (next !== null) onChange(next);
      }}
      aria-label={ariaLabel}
    >
      <ToggleButton value="HYBRID">{labels.hybrid}</ToggleButton>
      <ToggleButton value="SEMANTIC">{labels.semantic}</ToggleButton>
      <ToggleButton value="TEXT">{labels.keyword}</ToggleButton>
    </ToggleButtonGroup>
  );
}
