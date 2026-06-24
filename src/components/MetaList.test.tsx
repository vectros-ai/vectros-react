// ---------------------------------------------------------------------------
// MetaList / MetaRow tests — the semantic <dl>/<dt>/<dd> structure that the
// hand-rolled copies were meant to provide.
// ---------------------------------------------------------------------------

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MetaList, MetaRow } from './MetaList';

describe('MetaList / MetaRow', () => {
  it('renders a description list with dt/dd pairs', () => {
    render(
      <MetaList>
        <MetaRow label="Status">Active</MetaRow>
        <MetaRow label="Version">3</MetaRow>
      </MetaList>,
    );

    const term = screen.getByText('Status');
    expect(term.tagName).toBe('DT');
    const value = screen.getByText('Active');
    expect(value.closest('dd')).not.toBeNull();

    // The wrapping element is a <dl>.
    expect(term.closest('dl')).not.toBeNull();
  });

  it('renders the value node inside the row', () => {
    render(
      <MetaList>
        <MetaRow label="Owner">
          <span data-testid="owner">user-123</span>
        </MetaRow>
      </MetaList>,
    );
    expect(screen.getByTestId('owner')).toHaveTextContent('user-123');
  });
});
