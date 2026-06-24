// ---------------------------------------------------------------------------
// SubmitButton tests — the busy semantics (spinner, disabled, aria-busy) and
// the pass-through behavior that lets it stand in for a plain MUI Button.
// ---------------------------------------------------------------------------

import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SubmitButton } from './SubmitButton';

describe('SubmitButton', () => {
  it('is enabled and clickable when not pending', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<SubmitButton onClick={onClick}>Save</SubmitButton>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute('aria-busy');
    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('disables and sets aria-busy while pending', () => {
    render(
      <SubmitButton pending onClick={vi.fn()}>
        Save
      </SubmitButton>,
    );
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    // The pending spinner is present.
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('does not fire onClick while pending', () => {
    const onClick = vi.fn();
    render(
      <SubmitButton pending onClick={onClick}>
        Save
      </SubmitButton>,
    );
    // fireEvent dispatches past the pointer-events guard; React still swallows
    // the click on a disabled button.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('honors an explicit disabled even when not pending', () => {
    render(
      <SubmitButton disabled onClick={vi.fn()}>
        Save
      </SubmitButton>,
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
