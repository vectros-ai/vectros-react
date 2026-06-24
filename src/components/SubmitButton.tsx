// ---------------------------------------------------------------------------
// SubmitButton — a MUI Button that reflects an in-flight mutation.
//
// When `pending` is true it shows a leading spinner, disables itself, and sets
// `aria-busy` so assistive technology announces the in-progress state. Extracted
// because the exact `startIcon={pending ? <CircularProgress size={16}/> : …}`
// + `disabled` pattern was repeated on every dialog/form submit button (~6
// sites); centralizing it makes the busy a11y semantics uniform.
//
// Forwards all MUI ButtonProps, so callers keep full control of variant/color/
// type/onClick. `pending` composes with an explicit `disabled`.
// ---------------------------------------------------------------------------

import { Button, CircularProgress } from '@mui/material';
import type { ButtonProps } from '@mui/material';

export interface SubmitButtonProps extends ButtonProps {
  /** True while the underlying action is in flight — shows a spinner, disables, sets aria-busy. */
  readonly pending?: boolean;
}

/**
 * A submit/confirm button that shows a spinner and disables while `pending`.
 * Pass-through props (variant, color, onClick, type, children) behave as on a
 * plain MUI Button.
 */
export function SubmitButton({
  pending = false,
  disabled,
  startIcon,
  children,
  ...rest
}: SubmitButtonProps): React.JSX.Element {
  return (
    <Button
      {...rest}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      startIcon={pending ? <CircularProgress size={16} color="inherit" /> : startIcon}
    >
      {children}
    </Button>
  );
}
