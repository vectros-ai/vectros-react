// ---------------------------------------------------------------------------
// SearchModeToggle tests — the three modes render with their given labels,
// exactly one is selected at a time, and a click reports the new value
// rather than mutating anything itself (a controlled component).
// ---------------------------------------------------------------------------

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SearchModeToggle } from './SearchModeToggle';

const LABELS = { hybrid: 'Hybrid', semantic: 'Semantic', keyword: 'Keyword' };

describe('SearchModeToggle', () => {
  it('renders all three modes with the given labels, one pressed', () => {
    render(<SearchModeToggle value="SEMANTIC" onChange={vi.fn()} labels={LABELS} ariaLabel="Ranking mode" />);
    expect(screen.getByRole('button', { name: 'Hybrid' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Semantic' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Keyword' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('reports the newly clicked mode via onChange, controlled (no self-mutation)', async () => {
    const onChange = vi.fn();
    render(<SearchModeToggle value="HYBRID" onChange={onChange} labels={LABELS} ariaLabel="Ranking mode" />);
    await userEvent.click(screen.getByRole('button', { name: 'Keyword' }));
    expect(onChange).toHaveBeenCalledWith('TEXT');
    // Still shows the prop value (HYBRID) — the caller owns state, this didn't flip itself.
    expect(screen.getByRole('button', { name: 'Hybrid' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('does not call onChange when clicking the already-selected mode', async () => {
    const onChange = vi.fn();
    render(<SearchModeToggle value="HYBRID" onChange={onChange} labels={LABELS} ariaLabel="Ranking mode" />);
    await userEvent.click(screen.getByRole('button', { name: 'Hybrid' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
