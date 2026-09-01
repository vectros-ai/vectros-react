// ---------------------------------------------------------------------------
// SearchResultCard tests — the link/plain-text title split, the similarity
// badge's presence/absence, and that every prop the host supplies actually
// renders (this is a pure presentational primitive: the host resolves all
// the data, so the contract is "renders what it's given, correctly").
// ---------------------------------------------------------------------------

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SearchResultCard } from './SearchResultCard';

describe('SearchResultCard', () => {
  it('renders a linked title via the given link component when href is set', () => {
    const Anchor = ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
      <a href={to} {...rest}>
        {children}
      </a>
    );
    render(
      <SearchResultCard title="Grievance" typeLabel="Case" href="/cases/case_1" linkComponent={Anchor} />,
    );
    expect(screen.getByRole('link', { name: 'Grievance' })).toHaveAttribute('href', '/cases/case_1');
  });

  it('renders a plain <a> when href is set but linkComponent is omitted', () => {
    render(<SearchResultCard title="Grievance" typeLabel="Case" href="/cases/case_1" />);
    expect(screen.getByRole('link', { name: 'Grievance' })).toHaveAttribute('href', '/cases/case_1');
  });

  it('renders plain (non-linked) text when href is omitted', () => {
    render(<SearchResultCard title="Intake form.pdf" typeLabel="Document" />);
    expect(screen.getByText('Intake form.pdf')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders plain text when href is explicitly null (an unresolved reference)', () => {
    render(<SearchResultCard title="Intake note" typeLabel="Case entry" href={null} />);
    expect(screen.getByText('Intake note')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows the similarity badge only when a positive score is given', () => {
    const { rerender } = render(
      <SearchResultCard
        title="A"
        typeLabel="Case"
        similarityPercent={87}
        similarityLabel="Semantic match"
      />,
    );
    expect(screen.getByText('87%')).toBeInTheDocument();

    rerender(<SearchResultCard title="A" typeLabel="Case" similarityPercent={null} />);
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();

    rerender(<SearchResultCard title="A" typeLabel="Case" similarityPercent={0} />);
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it('renders the snippet, date, and id caption when given', () => {
    render(
      <SearchResultCard
        title="A"
        typeLabel="Case"
        snippet="A grievance about scheduling."
        dateLabel="Aug 1, 2026"
        idCaption="case_1"
      />,
    );
    expect(screen.getByText('A grievance about scheduling.')).toBeInTheDocument();
    expect(screen.getByText('Aug 1, 2026')).toBeInTheDocument();
    expect(screen.getByText('case_1')).toBeInTheDocument();
  });
});
