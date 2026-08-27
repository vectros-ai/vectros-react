// ---------------------------------------------------------------------------
// RecordFormFields tests — typed inputs, required/enum errors, and the
// raw-only hint for complex + unstructured keys.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { RecordFormFields } from './RecordFormFields';
import { TestIntlProvider } from '../test/intl';
import type { Vectros } from '@vectros-ai/sdk';
import type { FieldErrors, RenderHints } from './recordForm';

type FieldDef = Vectros.FieldDef;

const FIELDS: FieldDef[] = [
  { fieldId: 'name', fieldType: 'string', required: true },
  { fieldId: 'active', fieldType: 'boolean' },
  { fieldId: 'color', fieldType: 'enum', enumValues: [{ value: 'red' }, { value: 'blue' }] },
  { fieldId: 'tags', fieldType: 'array' },
];

function renderFields(
  value: Record<string, unknown>,
  errors: FieldErrors,
  onChange = vi.fn(),
): { onChange: ReturnType<typeof vi.fn> } {
  render(
    <TestIntlProvider>
      <RecordFormFields fields={FIELDS} value={value} errors={errors} onChange={onChange} />
    </TestIntlProvider>,
  );
  return { onChange };
}

describe('RecordFormFields', () => {
  it('renders typed inputs and lists complex + unstructured keys as raw-only', () => {
    renderFields({ active: true, note: 'extra' }, {});

    expect(screen.getByRole('textbox', { name: /name/ })).toBeInTheDocument();
    expect(screen.getByLabelText('active')).toBeChecked();
    expect(screen.getByRole('combobox', { name: /color/ })).toBeInTheDocument();

    // 'tags' (complex) + 'note' (unstructured) are surfaced as raw-only chips.
    expect(screen.getByText(/only be edited in the raw/i)).toBeInTheDocument();
    expect(screen.getByText('tags')).toBeInTheDocument();
    expect(screen.getByText('note')).toBeInTheDocument();
  });

  it('shows the required error message on a flagged field', () => {
    renderFields({}, { name: 'required' });
    expect(screen.getByText('This field is required.')).toBeInTheDocument();
  });

  it('reports a boolean toggle as a boolean input', async () => {
    const user = userEvent.setup();
    const { onChange } = renderFields({ active: true }, {});
    await user.click(screen.getByLabelText('active'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ fieldId: 'active' }), false);
  });

  it('applies renderHints: label override, section heading, helpText, and order', () => {
    const fields: FieldDef[] = [
      { fieldId: 'last', fieldType: 'string' },
      { fieldId: 'first', fieldType: 'string' },
      { fieldId: 'bio', fieldType: 'string' },
    ];
    const renderHints: RenderHints = {
      first: { label: 'First name', order: 1, section: 'Identity', helpText: 'Given name' },
      last: { label: 'Last name', order: 2, section: 'Identity' },
      bio: { label: 'Biography', order: 3, widget: 'textarea' },
    };
    render(
      <TestIntlProvider>
        <RecordFormFields
          fields={fields}
          value={{}}
          errors={{}}
          renderHints={renderHints}
          onChange={vi.fn()}
        />
      </TestIntlProvider>,
    );

    // Hint label is used; the section heading renders.
    expect(screen.getByRole('textbox', { name: 'First name' })).toBeInTheDocument();
    expect(screen.getByText('Identity')).toBeInTheDocument();
    expect(screen.getByText('Given name')).toBeInTheDocument();

    // order=1 (first) precedes order=2 (last) in the DOM despite declared order.
    const firstInput = screen.getByRole('textbox', { name: 'First name' });
    const lastInput = screen.getByRole('textbox', { name: 'Last name' });
    expect(
      firstInput.compareDocumentPosition(lastInput) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // The textarea-widget field renders a multiline input.
    const bio = screen.getByRole('textbox', { name: 'Biography' });
    expect(bio.tagName).toBe('TEXTAREA');
  });

  it('renders a bare `date` field as a datetime-local picker, value padded to midnight', () => {
    const fields: FieldDef[] = [{ fieldId: 'startsAt', fieldType: 'date' }];
    render(
      <TestIntlProvider>
        <RecordFormFields
          fields={fields}
          value={{ startsAt: '2026-06-23' }}
          errors={{}}
          onChange={vi.fn()}
        />
      </TestIntlProvider>,
    );
    const input = screen.getByLabelText('startsAt');
    expect(input).toHaveAttribute('type', 'datetime-local');
    expect(input).toHaveValue('2026-06-23T00:00');
  });

  it('pins a `date` field to date-only via a `date` widget hint', () => {
    const fields: FieldDef[] = [{ fieldId: 'due', fieldType: 'date' }];
    const renderHints: RenderHints = { due: { widget: 'date' } } as RenderHints;
    render(
      <TestIntlProvider>
        <RecordFormFields
          fields={fields}
          value={{ due: '2026-06-23T14:30:00Z' }}
          errors={{}}
          renderHints={renderHints}
          onChange={vi.fn()}
        />
      </TestIntlProvider>,
    );
    const input = screen.getByLabelText('due');
    expect(input).toHaveAttribute('type', 'date');
    expect(input).toHaveValue('2026-06-23');
  });
});
