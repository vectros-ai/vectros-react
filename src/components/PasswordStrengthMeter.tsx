// ---------------------------------------------------------------------------
// PasswordStrengthMeter — visual + accessible strength gauge for the
// PasswordField component.
//
// This file is the LAZY-LOADED CHUNK behind PasswordField's strength meter.
// PasswordField imports it via React.lazy, so the zxcvbn-ts dictionary
// (~150KB gzipped) only lands on the bundle when an instance actually
// renders. The Login bundle never imports this file — Login passes
// showStrengthMeter={false} and React.lazy never invokes its loader.
// See PasswordField.tsx for the broader rationale.
//
// **zxcvbn-ts setup**: the library requires a one-time setOptions() call
// to register the dictionary + graphs + translations. We do that on first
// mount in a module-scoped Promise that all subsequent component instances
// share (no double-initialization). Initialization is async because the
// dictionaries are dynamic imports themselves.
//
// **Why zxcvbn over a length-based heuristic**: real entropy estimation
// matches what attackers actually do. "Tr0ub4dor&3" scores Fair (3) despite
// 11 mixed-case chars; "correct horse battery staple" scores Strong (4).
// Length alone gets both wrong.
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react';
import { Box, Typography } from '@mui/material';
import { FormattedMessage } from 'react-intl';

// ---------------------------------------------------------------------------
// One-time zxcvbn-ts initialization, memoized across all consumers.
//
// `zxcvbnOptions.setOptions` is idempotent in the library's internals
// (subsequent calls reset the dict + graphs to the latest provided
// values); we still wrap it in a once-only Promise so we don't pay for
// repeated dynamic-imports of the language pack across re-mounts.
// ---------------------------------------------------------------------------

let zxcvbnPromise: Promise<(password: string) => Promise<ZxcvbnResult>> | null = null;

interface ZxcvbnResult {
  /** 0 = very weak, 4 = strong. */
  readonly score: 0 | 1 | 2 | 3 | 4;
}

/**
 * Load + initialize zxcvbn-ts. Returns the async scorer. First call pays
 * the dictionary-fetch cost; subsequent calls return the cached scorer
 * immediately.
 */
function loadZxcvbn(): Promise<(password: string) => Promise<ZxcvbnResult>> {
  if (zxcvbnPromise) return zxcvbnPromise;
  zxcvbnPromise = (async () => {
    // Dynamic-import the three halves in parallel so the network-bound
    // waterfall is one round-trip, not three. `core` ships the scorer;
    // `language-common` ships the graph adjacency data (keyboard
    // layouts, etc.) shared across all languages; `language-en` ships
    // English-specific dictionaries + translations.
    const [coreMod, commonMod, enMod] = await Promise.all([
      import('@zxcvbn-ts/core'),
      import('@zxcvbn-ts/language-common'),
      import('@zxcvbn-ts/language-en'),
    ]);
    coreMod.zxcvbnOptions.setOptions({
      translations: enMod.translations,
      graphs: commonMod.adjacencyGraphs,
      dictionary: {
        ...commonMod.dictionary,
        ...enMod.dictionary,
      },
    });
    return coreMod.zxcvbnAsync as (password: string) => Promise<ZxcvbnResult>;
  })();
  return zxcvbnPromise;
}

// ---------------------------------------------------------------------------
// Score → visual mapping
// ---------------------------------------------------------------------------

type Score = 0 | 1 | 2 | 3 | 4;

/** Map zxcvbn's 0-4 score to an MUI palette token for the meter bar segments. */
function scoreToColor(score: Score): string {
  if (score <= 1) return 'error.main';
  if (score === 2) return 'warning.main';
  return 'success.main';
}

/** Map score to the i18n message key for the label text. */
function scoreToLabelKey(score: Score): string {
  switch (score) {
    case 0: return 'password.strengthVeryWeak';
    case 1: return 'password.strengthWeak';
    case 2: return 'password.strengthFair';
    case 3: return 'password.strengthGood';
    case 4: return 'password.strengthStrong';
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface PasswordStrengthMeterProps {
  /** Current password value. Empty string hides the meter entirely. */
  readonly value: string;
  /** Optional callback fired when the score changes (incl. on initial mount). */
  readonly onStrengthChange?: (score: Score) => void;
  /** id for `aria-describedby` from the parent input — wired in PasswordField. */
  readonly id?: string;
}

/**
 * Renders a 4-segment strength bar + label. Hidden when `value` is empty
 * so the user sees nothing until they start typing.
 *
 * The score computation is async (zxcvbn-ts runs off the main thread when
 * possible). We optimistically render the empty state on first mount,
 * then re-render once the score resolves. On subsequent value changes, we
 * keep showing the LAST resolved score until the new one arrives —
 * avoids flicker.
 *
 * Default export so React.lazy() can grab it.
 */
function PasswordStrengthMeter({
  value,
  onStrengthChange,
  id,
}: PasswordStrengthMeterProps): React.JSX.Element | null {
  const [score, setScore] = useState<Score | null>(null);

  useEffect(() => {
    if (!value) {
      // Reset to null so the meter hides when the input clears. Don't
      // emit onStrengthChange — the parent already knows the value
      // emptied.
      setScore(null);
      return;
    }
    let cancelled = false;
    void loadZxcvbn().then((scorer) =>
      scorer(value).then((result) => {
        if (cancelled) return;
        const next = result.score;
        setScore((prev) => {
          if (prev !== next && onStrengthChange) onStrengthChange(next);
          return next;
        });
      }),
    );
    return (): void => {
      cancelled = true;
    };
  }, [value, onStrengthChange]);

  // Empty value OR initial-load-pending → render nothing. The "calculating"
  // state would be a flicker for fast-typing users; matching it to the
  // emptied state keeps the surface visually quiet.
  if (!value || score === null) return null;

  const barColor = scoreToColor(score);

  return (
    <Box
      id={id}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={4}
      aria-valuenow={score}
      aria-label="Password strength"
      sx={{ mt: 0.5 }}
    >
      <Box sx={{ display: 'flex', gap: 0.5 }} aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <Box
            key={i}
            sx={{
              flex: 1,
              height: 4,
              borderRadius: 1,
              bgcolor: i < score ? barColor : 'action.disabledBackground',
              transition: 'background-color 120ms ease',
            }}
          />
        ))}
      </Box>
      <Typography
        variant="caption"
        component="div"
        sx={{ mt: 0.25, color: barColor, fontWeight: 500 }}
      >
        <FormattedMessage id="password.strengthLabel" />
        {': '}
        <FormattedMessage id={scoreToLabelKey(score)} />
      </Typography>
    </Box>
  );
}

export default PasswordStrengthMeter;
