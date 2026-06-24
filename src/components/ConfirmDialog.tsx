// ---------------------------------------------------------------------------
// ConfirmDialog — a modal "are you sure?" confirmation.
//
// The destructive-action confirmation (delete record / delete document / delete
// folder) was hand-rolled ≥3× with subtly different a11y wiring. This primitive
// centralizes the things that are easy to get wrong each time:
//   - `aria-labelledby` linked to the title (a generated, collision-free id),
//   - the close handler is blocked while the action is pending (no dismiss
//     mid-mutation), and the cancel button disables to match,
//   - the confirm button shows a spinner + `aria-busy` while pending,
//   - a failure message renders INSIDE the dialog (so it isn't occluded by the
//     still-open modal — the bug this primitive exists to prevent), with
//     `role="alert"` so it is announced.
//
// Copy-agnostic: title/body/labels/error are ReactNode supplied (localized) by
// the host app.
// ---------------------------------------------------------------------------

import { useId } from 'react';
import type { ReactNode } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
} from '@mui/material';

import { SubmitButton } from './SubmitButton';

export interface ConfirmDialogProps {
  /** Whether the dialog is open. */
  readonly open: boolean;
  /** Dialog heading (also the accessible name via aria-labelledby). */
  readonly title: ReactNode;
  /** Body prompt — inline prose, rendered as muted DialogContentText. */
  readonly body: ReactNode;
  /** Confirm-button label (e.g. "Delete record"). */
  readonly confirmLabel: ReactNode;
  /** Cancel-button label (e.g. "Cancel"). */
  readonly cancelLabel: ReactNode;
  /** Invoked when the user confirms. */
  readonly onConfirm: () => void;
  /** Invoked when the user cancels or dismisses (ignored while `pending`). */
  readonly onClose: () => void;
  /** True while the confirmed action is in flight. */
  readonly pending?: boolean;
  /**
   * Render the confirm button as destructive (error color). Defaults to true —
   * the dominant use is delete confirmation.
   */
  readonly destructive?: boolean;
  /**
   * Disable the confirm button while leaving the dialog open and dismissable
   * (e.g. a type-to-confirm phrase not yet matched, or a precondition unmet).
   * Independent of `pending` — composes with it (either disables confirm).
   * Defaults to false. Cancel/dismiss remain available; only `pending` blocks
   * dismissal.
   *
   * A11y: a disabled control gives screen-reader users no reason WHY — convey
   * the gating condition in `body` (or the `error` slot) so it's announced.
   */
  readonly confirmDisabled?: boolean;
  /**
   * A failure message to show inside the dialog (e.g. after the action errored).
   * Rendered as a `role="alert"` so it is announced and is never occluded by
   * the open modal.
   */
  readonly error?: ReactNode;
}

/**
 * A modal confirmation dialog with built-in pending state, an in-dialog error
 * slot, and correct `aria-labelledby` wiring. Use for destructive or
 * irreversible actions.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onClose,
  pending = false,
  destructive = true,
  confirmDisabled = false,
  error,
}: ConfirmDialogProps): React.JSX.Element {
  const titleId = useId();
  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!pending) onClose();
      }}
      aria-labelledby={titleId}
    >
      <DialogTitle id={titleId}>{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          {error !== undefined && error !== null && error !== false && (
            <Alert severity="error" role="alert">
              {error}
            </Alert>
          )}
          <DialogContentText>{body}</DialogContentText>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={pending}>
          {cancelLabel}
        </Button>
        <SubmitButton
          variant="contained"
          color={destructive ? 'error' : 'primary'}
          onClick={onConfirm}
          pending={pending}
          disabled={confirmDisabled}
        >
          {confirmLabel}
        </SubmitButton>
      </DialogActions>
    </Dialog>
  );
}
