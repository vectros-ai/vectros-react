// ---------------------------------------------------------------------------
// ConfirmDialog tests — the invariants that make it safer than a hand-rolled
// dialog: aria-labelledby wiring, pending blocks dismissal + cancel, the error
// renders inside the dialog (announced, not occluded), and confirm fires.
// ---------------------------------------------------------------------------

import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from './ConfirmDialog';

function renderDialog(overrides: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  render(
    <ConfirmDialog
      open
      title="Delete this record?"
      body="This can't be undone."
      confirmLabel="Delete record"
      cancelLabel="Cancel"
      onConfirm={onConfirm}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onConfirm, onClose };
}

describe('ConfirmDialog', () => {
  it('labels the dialog by its title', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Delete this record?' });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText("This can't be undone.")).toBeInTheDocument();
  });

  it('fires onConfirm when the confirm button is clicked', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Delete record' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('fires onClose when cancel is clicked', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('while pending: disables both buttons and does not fire confirm', () => {
    const { onConfirm } = renderDialog({ pending: true });
    const confirm = screen.getByRole('button', { name: 'Delete record' });
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    // fireEvent bypasses the pointer-events guard; the disabled button still
    // swallows the click.
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('does not dismiss on Escape while pending', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog({ pending: true });
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('dismisses on Escape when not pending', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders the error inside the dialog as an alert', () => {
    renderDialog({ error: 'We could not delete this record.' });
    const dialog = screen.getByRole('dialog');
    const alert = within(dialog).getByRole('alert');
    expect(alert).toHaveTextContent('We could not delete this record.');
  });

  it('omits the error alert when no error is given', () => {
    renderDialog();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('uses the error color for a destructive confirm by default', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: 'Delete record' })).toHaveClass('MuiButton-colorError');
  });

  it('confirmDisabled: disables the confirm button and does not fire confirm', () => {
    const { onConfirm } = renderDialog({ confirmDisabled: true });
    const confirm = screen.getByRole('button', { name: 'Delete record' });
    expect(confirm).toBeDisabled();
    // Not a pending state — no busy semantics.
    expect(confirm).not.toHaveAttribute('aria-busy', 'true');
    // fireEvent bypasses the pointer-events guard; the disabled button still
    // swallows the click.
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('confirmDisabled: cancel still dismisses (unlike pending)', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog({ confirmDisabled: true });
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('confirmDisabled: Escape still dismisses (unlike pending)', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog({ confirmDisabled: true });
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('confirmDisabled composes with pending: confirm disabled + still busy + dismissal blocked', () => {
    const { onClose } = renderDialog({ confirmDisabled: true, pending: true });
    const confirm = screen.getByRole('button', { name: 'Delete record' });
    expect(confirm).toBeDisabled();
    // pending dominates the busy semantics + dismissal guard.
    expect(confirm).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('confirm is enabled by default (confirmDisabled omitted)', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: 'Delete record' })).toBeEnabled();
  });
});
