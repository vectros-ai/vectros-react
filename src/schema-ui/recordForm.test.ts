// ---------------------------------------------------------------------------
// recordForm helper tests — field-type mapping, coercion, validation,
// unstructured-key detection, immutable field writes.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import {
  coerceFieldValue,
  enumOptions,
  fieldHelpText,
  fieldLabel,
  fieldWidget,
  groupFieldsBySection,
  isFormEditable,
  isReservedPayloadKey,
  orderedFormFields,
  stripReservedPayloadKeys,
  temporalInputKind,
  toDateInputValue,
  toDateTimeLocalInputValue,
  unstructuredKeys,
  validateFields,
  withField,
} from './recordForm';
import type { RenderHints } from './recordForm';
import type { Vectros } from '@vectros-ai/sdk';

type FieldDef = Vectros.FieldDef;

// `fieldType` is intentionally a plain `string` (not the `FieldDef['fieldType']`
// union) so tests can probe unknown/future types like 'mystery' for the
// raw-view fallback. Cast at the boundary to satisfy the typed FieldDef.
const field = (fieldId: string, fieldType: string, extra: Partial<FieldDef> = {}): FieldDef => ({
  fieldId,
  fieldType: fieldType as FieldDef['fieldType'],
  ...extra,
});

describe('isFormEditable', () => {
  it('accepts scalar types and rejects complex/unknown', () => {
    for (const t of ['string', 'number', 'boolean', 'date', 'enum']) {
      expect(isFormEditable(field('x', t))).toBe(true);
    }
    for (const t of ['array', 'object', 'reference', 'mystery']) {
      expect(isFormEditable(field('x', t))).toBe(false);
    }
  });
});

describe('coerceFieldValue', () => {
  it('coerces numbers, keeping non-numeric text and dropping empties', () => {
    const f = field('n', 'number');
    expect(coerceFieldValue(f, '3')).toBe(3);
    expect(coerceFieldValue(f, '')).toBeUndefined();
    expect(coerceFieldValue(f, 'abc')).toBe('abc');
  });

  it('coerces booleans from switch or string', () => {
    const f = field('b', 'boolean');
    expect(coerceFieldValue(f, true)).toBe(true);
    expect(coerceFieldValue(f, 'true')).toBe(true);
    expect(coerceFieldValue(f, 'false')).toBe(false);
  });

  it('keeps strings (including empty) and drops empty date/enum', () => {
    expect(coerceFieldValue(field('s', 'string'), '')).toBe('');
    expect(coerceFieldValue(field('s', 'string'), 'hi')).toBe('hi');
    expect(coerceFieldValue(field('d', 'date'), '')).toBeUndefined();
    expect(coerceFieldValue(field('d', 'date'), '2026-01-01')).toBe('2026-01-01');
    expect(coerceFieldValue(field('e', 'enum'), '')).toBeUndefined();
  });
});

describe('enumOptions', () => {
  it('reads {value} entries', () => {
    const f = field('e', 'enum', { enumValues: [{ value: 'a' }, { value: 'b' }] });
    expect(enumOptions(f)).toEqual(['a', 'b']);
  });

  it('is empty when no enumValues', () => {
    expect(enumOptions(field('e', 'enum'))).toEqual([]);
  });
});

describe('unstructuredKeys', () => {
  it('returns sorted keys not described by the schema', () => {
    const fields = [field('a', 'string'), field('b', 'number')];
    expect(unstructuredKeys(fields, { a: 1, z: 2, b: 3, m: 4 })).toEqual(['m', 'z']);
  });
});

describe('validateFields', () => {
  it('flags missing required fields', () => {
    const fields = [field('name', 'string', { required: true }), field('age', 'number')];
    expect(validateFields(fields, {})).toEqual({ name: 'required' });
    expect(validateFields(fields, { name: 'Alice' })).toEqual({});
  });

  it('flags enum values outside the allowed set', () => {
    const fields = [field('color', 'enum', { enumValues: [{ value: 'red' }, { value: 'blue' }] })];
    expect(validateFields(fields, { color: 'green' })).toEqual({ color: 'enum' });
    expect(validateFields(fields, { color: 'red' })).toEqual({});
  });

  it('ignores complex (non-form) fields', () => {
    const fields = [field('tags', 'array', { required: true })];
    expect(validateFields(fields, {})).toEqual({});
  });
});

describe('renderHints accessors', () => {
  const f = field('firstName', 'string');
  const hints: RenderHints = {
    firstName: { label: 'First name', helpText: 'Legal given name', widget: 'textarea' },
  };

  it('fieldLabel prefers the hint label, falls back to fieldId', () => {
    expect(fieldLabel(f, hints)).toBe('First name');
    expect(fieldLabel(f)).toBe('firstName');
    expect(fieldLabel(f, { firstName: { label: '  ' } })).toBe('firstName'); // blank → fallback
  });

  it('fieldHelpText prefers helpText, then description, then undefined', () => {
    expect(fieldHelpText(f, hints)).toBe('Legal given name');
    expect(fieldHelpText(field('x', 'string', { description: 'desc' }))).toBe('desc');
    expect(fieldHelpText(field('x', 'string'))).toBeUndefined();
  });

  it('fieldWidget returns the widget hint or undefined', () => {
    expect(fieldWidget(f, hints)).toBe('textarea');
    expect(fieldWidget(f)).toBeUndefined();
  });
});

describe('orderedFormFields', () => {
  it('sorts editable fields by hint.order (missing order last, stable)', () => {
    const fields = [
      field('a', 'string'), // no order → last
      field('b', 'string'),
      field('c', 'array'), // not editable → dropped
      field('d', 'string'),
    ];
    const hints: RenderHints = { d: { order: 1 }, b: { order: 2 } };
    expect(orderedFormFields(fields, hints).map((x) => x.fieldId)).toEqual(['d', 'b', 'a']);
  });

  it('preserves declared order with no hints', () => {
    const fields = [field('a', 'string'), field('b', 'number')];
    expect(orderedFormFields(fields).map((x) => x.fieldId)).toEqual(['a', 'b']);
  });

  it('breaks equal orders by declared position (stable)', () => {
    const fields = [field('a', 'string'), field('b', 'string'), field('c', 'string')];
    const hints: RenderHints = { a: { order: 1 }, b: { order: 1 }, c: { order: 1 } };
    expect(orderedFormFields(fields, hints).map((x) => x.fieldId)).toEqual(['a', 'b', 'c']);
  });
});

describe('groupFieldsBySection', () => {
  it('groups by section, first-appearance order, single un-sectioned group', () => {
    const fields = [field('a', 'string'), field('b', 'string'), field('c', 'string')];
    const hints: RenderHints = {
      a: { section: 'Personal' },
      b: { section: 'Personal' },
      // c has no section
    };
    const groups = groupFieldsBySection(fields, hints);
    expect(groups.map((g) => g.section)).toEqual(['Personal', undefined]);
    expect(groups[0]?.fields.map((f) => f.fieldId)).toEqual(['a', 'b']);
    expect(groups[1]?.fields.map((f) => f.fieldId)).toEqual(['c']);
  });

  it('is one undefined-section group when no hints', () => {
    const fields = [field('a', 'string'), field('b', 'string')];
    const groups = groupFieldsBySection(fields);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.section).toBeUndefined();
    expect(groups[0]?.fields.map((f) => f.fieldId)).toEqual(['a', 'b']);
  });

  it('folds non-contiguous fields back into one section (heading emitted once)', () => {
    // a/Personal, b/Address, c/Personal → Personal is NOT re-opened for c.
    const fields = [field('a', 'string'), field('b', 'string'), field('c', 'string')];
    const hints: RenderHints = {
      a: { section: 'Personal' },
      b: { section: 'Address' },
      c: { section: 'Personal' },
    };
    const groups = groupFieldsBySection(fields, hints);
    expect(groups.map((g) => g.section)).toEqual(['Personal', 'Address']);
    expect(groups[0]?.fields.map((f) => f.fieldId)).toEqual(['a', 'c']);
    expect(groups[1]?.fields.map((f) => f.fieldId)).toEqual(['b']);
  });

  it('collapses a blank/whitespace section to the un-sectioned group', () => {
    const fields = [field('a', 'string'), field('b', 'string')];
    const hints: RenderHints = { a: { section: '   ' }, b: {} };
    const groups = groupFieldsBySection(fields, hints);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.section).toBeUndefined();
    expect(groups[0]?.fields.map((f) => f.fieldId)).toEqual(['a', 'b']);
  });
});

describe('withField', () => {
  it('sets a value immutably', () => {
    const base = { a: 1 };
    const next = withField(base, 'b', 2);
    expect(next).toEqual({ a: 1, b: 2 });
    expect(base).toEqual({ a: 1 });
  });

  it('deletes a key when the value is undefined', () => {
    expect(withField({ a: 1, b: 2 }, 'b', undefined)).toEqual({ a: 1 });
  });
});

describe('temporalInputKind', () => {
  const f = (fieldType: string): Vectros.FieldDef =>
    ({ fieldId: 'when', fieldType }) as Vectros.FieldDef;

  it('defaults a bare `date` field to datetime', () => {
    expect(temporalInputKind(f('date'))).toBe('datetime');
  });

  it('pins to date-only with a `date` widget hint', () => {
    const hints = { when: { widget: 'date' } } as const;
    expect(temporalInputKind(f('date'), hints)).toBe('date');
  });

  it('renders a `datetime` field type directly as datetime', () => {
    expect(temporalInputKind(f('datetime'))).toBe('datetime');
  });

  it('returns null for non-temporal fields', () => {
    expect(temporalInputKind(f('string'))).toBeNull();
    expect(temporalInputKind(f('number'))).toBeNull();
  });
});

describe('temporal input value normalization', () => {
  it('toDateInputValue keeps the date portion', () => {
    expect(toDateInputValue('2026-06-23')).toBe('2026-06-23');
    expect(toDateInputValue('2026-06-23T14:30:00Z')).toBe('2026-06-23');
    expect(toDateInputValue('')).toBe('');
    expect(toDateInputValue(42)).toBe('');
  });

  it('toDateTimeLocalInputValue pads date-only to midnight and trims to minutes', () => {
    expect(toDateTimeLocalInputValue('2026-06-23')).toBe('2026-06-23T00:00');
    expect(toDateTimeLocalInputValue('2026-06-23T14:30')).toBe('2026-06-23T14:30');
    expect(toDateTimeLocalInputValue('2026-06-23T14:30:59.123Z')).toBe('2026-06-23T14:30');
    expect(toDateTimeLocalInputValue('2026-06-23 14:30:00')).toBe('2026-06-23T14:30');
    expect(toDateTimeLocalInputValue('nonsense')).toBe('');
  });
});

describe('reserved payload keys', () => {
  it('flags the reserved top-level keys (matches the backend reserved set)', () => {
    for (const key of ['externalId', 'partnerUserId', 'userId', 'scopes']) {
      expect(isReservedPayloadKey(key)).toBe(true);
    }
    expect(isReservedPayloadKey('firstName')).toBe(false);
    // The retired `orgId`/`clientId` ownership fields are NOT reserved — ownership
    // is expressed through `scopes` now, so they are ordinary schema fields.
    expect(isReservedPayloadKey('orgId')).toBe(false);
    expect(isReservedPayloadKey('clientId')).toBe(false);
  });

  it('strips reserved keys from a payload, keeping the rest (incl. a now-unreserved orgId) and not mutating', () => {
    const base = {
      firstName: 'Alice',
      externalId: 'x',
      scopes: ['org:o'],
      userId: 'u',
      orgId: 'o', // no longer reserved — must survive as an ordinary field
      age: 30,
    };
    expect(stripReservedPayloadKeys(base)).toEqual({ firstName: 'Alice', orgId: 'o', age: 30 });
    // Input is untouched.
    expect(base.externalId).toBe('x');
  });
});
