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

  // The href is host-supplied and lands in an anchor, so a value with a script scheme
  // would run in the host's origin when clicked. Only http(s), mailto, an in-page
  // fragment, or a rooted path that stays on the site becomes a link; anything else
  // falls back to the same plain (non-linked) text an omitted href renders.
  describe('href allowlist', () => {
    const BS = String.fromCharCode(92);
    const TAB = String.fromCharCode(9);
    const NBSP = String.fromCharCode(0xa0);

    const rejected: ReadonlyArray<readonly [string, string]> = [
      ['javascript:', 'javascript:alert(1)'],
      ['a mixed-case script scheme', 'JaVaScRiPt:alert(1)'],
      ['a tab inside the scheme', `java${TAB}script:alert(1)`],
      ['a leading space before javascript:', ' javascript:alert(1)'],
      ['a leading NBSP before javascript:', `${NBSP}javascript:alert(1)`],
      ['data:', 'data:text/html,<script>alert(1)</script>'],
      ['vbscript:', 'vbscript:msgbox(1)'],
      ['blob:', 'blob:https://example.com/00000000-0000-0000-0000-000000000000'],
      ['file:', 'file:///etc/passwd'],
      ['protocol-relative', '//evil.example/x'],
      ['a rooted path with a backslash after the slash', `/${BS}evil.example`],
      ['a rooted path with a tab after the slash', `/${TAB}/evil.example`],
      ['a relative path', 'cases/case_1'],
      ['tel:', 'tel:+15555550123'],
      ['sms:', 'sms:+15555550123'],
      ['a custom app scheme', 'myapp://cases/1'],
      ['the empty string', ''],
    ];

    it.each(rejected)('renders %s as plain text, not a link (plain anchor)', (_name, href) => {
      const { container } = render(<SearchResultCard title="Grievance" typeLabel="Case" href={href} />);
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
      expect(container.querySelector('a[href]')).toBeNull();
      expect(screen.getByText('Grievance')).toBeInTheDocument();
    });

    it('does not crash on an href that is not a string, and renders plain text', () => {
      for (const bad of [5, ['/cases/1'], { toString: () => '/cases/1' }]) {
        const { container, unmount } = render(
          <SearchResultCard title="Grievance" typeLabel="Case" href={bad as unknown as string} />,
        );
        expect(container.querySelector('a[href]')).toBeNull();
        expect(screen.getByText('Grievance')).toBeInTheDocument();
        unmount();
      }
    });

    it.each(rejected)('renders %s as plain text, not a link (router link component)', (_name, href) => {
      const Anchor = ({ to, children, ...rest }: { to: string; children?: React.ReactNode }) => (
        <a href={to} {...rest}>
          {children}
        </a>
      );
      const { container } = render(
        <SearchResultCard title="Grievance" typeLabel="Case" href={href} linkComponent={Anchor} />,
      );
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
      expect(container.querySelector('a[href]')).toBeNull();
    });

    it.each([
      ['a rooted path', '/cases/case_1'],
      ['a rooted path with a query and fragment', '/cases/case_1?tab=notes#top'],
      ['an https URL', 'https://example.com/cases/1'],
      ['an http URL', 'http://example.com/cases/1'],
      ['an upper-case https scheme', 'HTTPS://example.com/cases/1'],
      ['a mailto: address', 'mailto:someone@example.com'],
      ['an in-page fragment', '#notes'],
    ])('still renders %s as a link (control)', (_name, href) => {
      render(<SearchResultCard title="Grievance" typeLabel="Case" href={href} />);
      expect(screen.getByRole('link', { name: 'Grievance' })).toHaveAttribute('href', href);
    });

    it('still renders a router-link hit for a rooted path (control)', () => {
      const Anchor = ({ to, children, ...rest }: { to: string; children?: React.ReactNode }) => (
        <a href={to} {...rest}>
          {children}
        </a>
      );
      render(<SearchResultCard title="Grievance" typeLabel="Case" href="/cases/case_1" linkComponent={Anchor} />);
      expect(screen.getByRole('link', { name: 'Grievance' })).toHaveAttribute('href', '/cases/case_1');
    });
  });
});
