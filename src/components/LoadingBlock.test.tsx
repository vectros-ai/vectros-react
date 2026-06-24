// ---------------------------------------------------------------------------
// LoadingBlock tests — the spinner must always carry its accessible label
// (the whole reason the primitive exists: no unlabeled spinners).
// ---------------------------------------------------------------------------

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { LoadingBlock } from './LoadingBlock';

describe('LoadingBlock', () => {
  it('exposes the label as the spinner accessible name', () => {
    render(<LoadingBlock label="Loading records" />);
    expect(screen.getByRole('progressbar', { name: 'Loading records' })).toBeInTheDocument();
  });

  it('renders a single progress indicator', () => {
    render(<LoadingBlock label="Loading" />);
    expect(screen.getAllByRole('progressbar')).toHaveLength(1);
  });
});
