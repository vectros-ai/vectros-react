// ---------------------------------------------------------------------------
// PasswordField tests.
//
// Strategy: render inside TestIntlProvider (IntlProvider over the real
// English catalog). Validate the four invariants the component is
// responsible for:
//
//   1. Visibility toggle — clicking the eye swaps type=password ⇄ type=text,
//      flips aria-label, flips aria-pressed.
//   2. CapsLock indicator — a keydown event with getModifierState('CapsLock')
//      returning true surfaces the indicator; keydown returning false hides it.
//   3. Pass-through props — value/onChange/required/disabled/error/helperText
//      all reach the underlying input + helper-text DOM.
//   4. Strength meter gate — only renders when showStrengthMeter is true;
//      gated by the existing PasswordStrengthMeter (lazy-loaded; covered by
//      its own dedicated test file).
//
// Notes on mocking: we mock the lazy-loaded PasswordStrengthMeter module so
// the tests don't depend on the zxcvbn-ts dictionary fetch (which jsdom's
// dynamic-import-via-vite happens to handle but slowly). The mock keeps the
// surface assertable without engaging the real scorer.
// ---------------------------------------------------------------------------

import { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

/**
 * Dispatch a synthetic keyboard event with a controlled `getModifierState`
 * override. `fireEvent.keyDown(node, { getModifierState: fn })` puts the
 * function as an own property on the event-init object, but React's
 * synthetic-event wrapper delegates to the native event's prototype
 * method — the own-property override is invisible. The fix: build the
 * native KeyboardEvent ourselves, override `getModifierState` via
 * Object.defineProperty, then dispatch via fireEvent (which calls
 * dispatchEvent under the hood; React's event delegation captures it).
 */
function fireKeyWithCapsLock(
  type: 'keyDown' | 'keyUp',
  node: HTMLElement,
  capsLock: boolean,
): void {
  const event = new KeyboardEvent(type === 'keyDown' ? 'keydown' : 'keyup', {
    key: 'a',
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, 'getModifierState', {
    value: (key: string) => key === 'CapsLock' && capsLock,
  });
  fireEvent(node, event);
}

import { PasswordField } from './PasswordField';
import { TestIntlProvider } from '../test/intl';

// Lightweight mock for the lazy chunk. Renders a stub element whose
// `data-testid` we can assert against without engaging the real scorer.
vi.mock('./PasswordStrengthMeter', () => ({
  default: ({ value, id }: { value: string; id?: string }) => (
    <div data-testid="strength-meter" data-value={value} id={id}>
      strength meter for: {value}
    </div>
  ),
}));

/**
 * Helper — render a controlled PasswordField with optional overrides.
 * Exposes the latest value via getByDisplayValue assertions on the input.
 */
function renderField(
  overrides: Partial<React.ComponentProps<typeof PasswordField>> = {},
): {
  readonly input: HTMLInputElement;
} {
  function Controlled(): React.JSX.Element {
    const [value, setValue] = useState(overrides.value ?? '');
    return (
      <PasswordField
        label="Password"
        autoComplete="current-password"
        {...overrides}
        value={value}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
          setValue(e.target.value);
          overrides.onChange?.(e);
        }}
      />
    );
  }
  render(
    <TestIntlProvider>
      <Controlled />
    </TestIntlProvider>,
  );
  // Use the label query — the DOM element is the input regardless of
  // type='password' vs type='text'.
  // /^Password\b/ matches both "Password" (no required prop) and the
  // MUI-required-state label "Password *" (asterisk after the word
  // boundary). Anchoring to "Password$" exact-match broke when required
  // was true.
  const input = screen.getByLabelText(/^Password\b/) as HTMLInputElement;
  return { input };
}

describe('PasswordField — visibility toggle', () => {
  it('starts with type=password and "Show password" toggle', () => {
    const { input } = renderField();
    expect(input).toHaveAttribute('type', 'password');
    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  it('flips to type=text + "Hide password" + aria-pressed=true on click', async () => {
    const user = userEvent.setup();
    const { input } = renderField();
    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(input).toHaveAttribute('type', 'text');
    const toggle = screen.getByRole('button', { name: 'Hide password' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

  it('flips back to type=password on a second click', async () => {
    const user = userEvent.setup();
    const { input } = renderField();
    await user.click(screen.getByRole('button', { name: 'Show password' }));
    await user.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(input).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('disables the toggle when the field is disabled', () => {
    renderField({ disabled: true });
    expect(screen.getByRole('button', { name: 'Show password' })).toBeDisabled();
  });
});

describe('PasswordField — CapsLock indicator', () => {
  it('does not show the indicator initially', () => {
    renderField();
    expect(screen.queryByText('Caps Lock is on')).not.toBeInTheDocument();
  });

  it('shows the indicator after a keydown with CapsLock on', () => {
    const { input } = renderField();
    fireKeyWithCapsLock('keyDown', input, true);
    expect(screen.getByText('Caps Lock is on')).toBeInTheDocument();
    expect(screen.getByText('Caps Lock is on')).toHaveAttribute('role', 'status');
  });

  it('hides the indicator when CapsLock turns off', () => {
    const { input } = renderField();
    fireKeyWithCapsLock('keyDown', input, true);
    expect(screen.getByText('Caps Lock is on')).toBeInTheDocument();
    fireKeyWithCapsLock('keyUp', input, false);
    expect(screen.queryByText('Caps Lock is on')).not.toBeInTheDocument();
  });
});

describe('PasswordField — pass-through props', () => {
  it('honors value + onChange', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderField({ onChange });
    await user.type(screen.getByLabelText(/^Password\b/), 'hunter2');
    expect(screen.getByLabelText(/^Password\b/)).toHaveValue('hunter2');
    expect(onChange).toHaveBeenCalled();
  });

  it('honors required', () => {
    renderField({ required: true });
    expect(screen.getByLabelText(/^Password\b/)).toBeRequired();
  });

  it('honors disabled', () => {
    renderField({ disabled: true });
    expect(screen.getByLabelText(/^Password\b/)).toBeDisabled();
  });

  it('honors helperText', () => {
    renderField({ helperText: 'Use at least 12 characters.' });
    expect(screen.getByText('Use at least 12 characters.')).toBeInTheDocument();
  });

  it('honors autoComplete', () => {
    renderField({ autoComplete: 'new-password' });
    expect(screen.getByLabelText(/^Password\b/)).toHaveAttribute(
      'autocomplete',
      'new-password',
    );
  });

  it('honors error', () => {
    // MUI renders aria-invalid on the input when error=true.
    renderField({ error: true });
    expect(screen.getByLabelText(/^Password\b/)).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });
});

describe('PasswordField — strength meter gate', () => {
  it('does NOT render the meter when showStrengthMeter is false', () => {
    renderField({ value: 'hunter2', showStrengthMeter: false });
    expect(screen.queryByTestId('strength-meter')).not.toBeInTheDocument();
  });

  it('does NOT render the meter when showStrengthMeter is unspecified (default)', () => {
    renderField({ value: 'hunter2' });
    expect(screen.queryByTestId('strength-meter')).not.toBeInTheDocument();
  });

  it('renders the meter when showStrengthMeter is true', async () => {
    renderField({ value: 'hunter2', showStrengthMeter: true });
    // The Suspense boundary resolves the mocked default synchronously in
    // jsdom; one waitFor handles the rare case where the lazy resolution
    // is microtask-deferred.
    await waitFor(() => {
      expect(screen.getByTestId('strength-meter')).toBeInTheDocument();
    });
  });

  it('passes value to the meter', async () => {
    renderField({ value: 'hunter2', showStrengthMeter: true });
    await waitFor(() => {
      expect(screen.getByTestId('strength-meter')).toHaveAttribute('data-value', 'hunter2');
    });
  });

  it('wires aria-describedby to the meter id when meter shows', async () => {
    renderField({ value: 'hunter2', showStrengthMeter: true, id: 'pw1' });
    await waitFor(() => {
      expect(screen.getByTestId('strength-meter')).toBeInTheDocument();
    });
    expect(screen.getByLabelText(/^Password\b/)).toHaveAttribute(
      'aria-describedby',
      'pw1-strength',
    );
  });

  it('omits aria-describedby when the meter is not showing', () => {
    renderField({ value: 'hunter2', showStrengthMeter: false, id: 'pw1' });
    expect(screen.getByLabelText(/^Password\b/)).not.toHaveAttribute('aria-describedby');
  });

  it('omits aria-describedby when the value is empty even with showStrengthMeter', () => {
    // The meter renders null when value is empty (no visible artifact for
    // describedby to point at); the wire-up should match.
    renderField({ value: '', showStrengthMeter: true, id: 'pw1' });
    expect(screen.getByLabelText(/^Password\b/)).not.toHaveAttribute('aria-describedby');
  });
});
