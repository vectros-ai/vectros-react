// ---------------------------------------------------------------------------
// PasswordField — shared password input with visibility toggle, CapsLock
// indicator, and optional strength meter.
//
// **Why this component exists.** The admin-app has 5 raw `<TextField
// type="password">` usages across LoginPage + AcceptPage + ForgotPasswordPage
// — every one carrying the same accessibility-correct visibility toggle +
// CapsLock-detection-on-focus + (for new-password fields) strength-meter
// boilerplate would copy-paste a moderate amount of code AND drift over
// time as bugs are fixed in only one site. One component encapsulates the
// invariants once.
//
// **Reference-app discipline.** Partner forks see this as the "good
// default" for password UX in 2026 — visibility toggle is a modern user
// expectation, CapsLock indication prevents a real category of "why doesn't
// my password work?" support tickets, and strength meters on new-password
// fields nudge users away from "Password1!"-class choices without
// gate-blocking them on submit (Cognito's password policy is the actual
// gate). Shipping a custom raw `<TextField type="password">` instead would
// fail the public-reference-app test.
//
// **Bundle-size discipline.** The strength meter relies on zxcvbn-ts whose
// English language pack ships a ~150KB-gzipped dictionary. We lazy-load
// the meter via React.lazy so:
//   - LoginPage (showStrengthMeter={false}) NEVER imports the dictionary —
//     React.lazy's loader is only invoked at render time when the meter
//     actually shows up.
//   - AcceptPage + ForgotPasswordPage (showStrengthMeter={true}) pull the
//     chunk on demand, after the form is rendered and the user starts
//     typing. First-paint stays fast.
//
// **Accessibility.**
//   - The visibility toggle is a focusable `<IconButton>` (default
//     tabIndex). Keyboard users CAN reach it via Tab — at the cost of one
//     extra Tab stop between the password input and the form submit. The
//     trade-off favors keyboard-only users who need to see what they
//     typed; sighted mouse users barely notice the extra stop. `aria-label`
//     swaps between "Show password" / "Hide password" + `aria-pressed`
//     reflects state.
//   - CapsLock indicator renders as a `<FormHelperText role="status">`
//     directly under the input — same a11y surface as any other helper-
//     text, screen readers announce it on appearance, no popup needed.
//   - Strength meter has `role="meter"` + valuemin / valuemax / valuenow +
//     `aria-label` so it's a first-class progress widget. See
//     PasswordStrengthMeter.tsx for the rendering details.
// ---------------------------------------------------------------------------

import { lazy, Suspense, useCallback, useId, useState } from 'react';
import type { ChangeEvent, FocusEventHandler, KeyboardEvent } from 'react';
import { FormHelperText, IconButton, InputAdornment, TextField } from '@mui/material';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import { FormattedMessage, useIntl } from 'react-intl';

// Lazy-loaded strength-meter chunk. React.lazy ensures the dictionary +
// zxcvbn engine only land in the bundle of pages that render this with
// showStrengthMeter={true}. See module docstring for why.
const PasswordStrengthMeter = lazy(() => import('./PasswordStrengthMeter'));

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface PasswordFieldProps {
  /** id attribute for the input. Auto-generated via useId() when absent. */
  readonly id?: string;
  /** Input name (form-submit attribute). */
  readonly name?: string;
  /** Visible label. Required for accessibility. */
  readonly label: string;
  /** Controlled value. */
  readonly value: string;
  /** Controlled-onChange handler. */
  readonly onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  /** Passed through to the input. */
  readonly onBlur?: FocusEventHandler<HTMLInputElement>;
  /** Required attribute on the input. */
  readonly required?: boolean;
  /** Disabled attribute on the input + the toggle button. */
  readonly disabled?: boolean;
  /** Error state — flips the underline to red. */
  readonly error?: boolean;
  /** Helper text shown below the input. CapsLock indicator stacks below this. */
  readonly helperText?: React.ReactNode;
  /**
   * Standard autocomplete hint. Required at every call site so password
   * managers can distinguish new-password fields from current-password
   * (matters for browser-prompt UX + which credential a manager offers).
   */
  readonly autoComplete: 'current-password' | 'new-password';
  /**
   * Pass true to render the strength meter below the input. Defaults
   * false — login (current-password) flows don't show it; new-password
   * flows (Accept, ForgotPassword reset) do.
   */
  readonly showStrengthMeter?: boolean;
  /**
   * Optional callback for the score (0=very weak … 4=strong). Parents
   * can use this to gate submission OR display a custom message; the
   * meter itself doesn't enforce a strength threshold (Cognito policy
   * is the gate). Only invoked when showStrengthMeter is true.
   */
  readonly onStrengthChange?: (score: 0 | 1 | 2 | 3 | 4) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Shared password input. See module docstring for design rationale.
 *
 * Typical usage:
 *
 *     <PasswordField
 *       label={intl.formatMessage({ id: 'login.passwordLabel' })}
 *       value={password}
 *       onChange={(e) => setPassword(e.target.value)}
 *       autoComplete="current-password"
 *       required
 *     />
 *
 * For new-password fields, opt in to the meter:
 *
 *     <PasswordField
 *       label={...}
 *       value={newPassword}
 *       onChange={...}
 *       autoComplete="new-password"
 *       showStrengthMeter
 *       required
 *     />
 */
export function PasswordField({
  id,
  name,
  label,
  value,
  onChange,
  onBlur,
  required,
  disabled,
  error,
  helperText,
  autoComplete,
  showStrengthMeter = false,
  onStrengthChange,
}: PasswordFieldProps): React.JSX.Element {
  const intl = useIntl();
  // Always generate a fallback id so the meter can wire `aria-describedby`
  // even when callers don't pass one. Caller-supplied id wins.
  const fallbackId = useId();
  const inputId = id ?? fallbackId;
  const meterId = `${inputId}-strength`;

  const [visible, setVisible] = useState(false);
  const [capsLockOn, setCapsLockOn] = useState(false);

  /** Toggle the type=password → type=text reveal. */
  const handleToggle = useCallback((): void => {
    setVisible((v) => !v);
  }, []);

  /**
   * Update CapsLock state on every key event. `getModifierState('CapsLock')`
   * is only available on KeyboardEvent — we can't detect caps before the
   * first key press (the user has to type at least one character for the
   * indicator to surface). That's acceptable: in practice, users type
   * something before submit, and the indicator surfaces by then.
   */
  const handleKey = useCallback((e: KeyboardEvent<HTMLInputElement>): void => {
    setCapsLockOn(e.getModifierState('CapsLock'));
  }, []);

  return (
    <div>
      <TextField
        id={inputId}
        name={name}
        label={label}
        type={visible ? 'text' : 'password'}
        autoComplete={autoComplete}
        value={value}
        onChange={onChange}
        onBlur={onBlur}
        onKeyDown={handleKey}
        onKeyUp={handleKey}
        required={required}
        disabled={disabled}
        error={error}
        helperText={helperText}
        fullWidth
        // MUI v7 idiom: slotProps over the legacy InputProps. See
        // CONVENTIONS.md § "Frontend — React + Vite + MUI gotchas".
        slotProps={{
          input: {
            endAdornment: (
              <InputAdornment position="end">
                <IconButton
                  aria-label={intl.formatMessage({
                    id: visible
                      ? 'password.visibilityToggleHide'
                      : 'password.visibilityToggleShow',
                  })}
                  aria-pressed={visible}
                  onClick={handleToggle}
                  edge="end"
                  disabled={disabled}
                  size="small"
                >
                  {visible ? <VisibilityOffIcon /> : <VisibilityIcon />}
                </IconButton>
              </InputAdornment>
            ),
            // Wire aria-describedby when the meter is showing so screen
            // readers announce the strength alongside the input. Avoids
            // the situation where a visually-sighted user sees the meter
            // but an AT user doesn't.
            ...(showStrengthMeter && value ? { 'aria-describedby': meterId } : {}),
          },
        }}
      />
      {/* CapsLock indicator — same FormHelperText element shape MUI uses
          for the input's built-in helperText, just below it. role="status"
          so screen readers announce when it appears. */}
      {capsLockOn && (
        <FormHelperText role="status" sx={{ ml: 1.75, mt: 0.25 }}>
          <FormattedMessage id="password.capsLockOn" />
        </FormHelperText>
      )}
      {showStrengthMeter && (
        <Suspense fallback={null}>
          <PasswordStrengthMeter
            value={value}
            id={meterId}
            {...(onStrengthChange ? { onStrengthChange } : {})}
          />
        </Suspense>
      )}
    </div>
  );
}
