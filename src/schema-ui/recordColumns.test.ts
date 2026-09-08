// ---------------------------------------------------------------------------
// recordColumns tests — schema-derived value columns, value formatting,
// comparator, stable sort, and free-text payload filtering.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import {
  compareValues,
  deriveValueColumns,
  filterableFieldIds,
  findDisplayFieldId,
  formatCellValue,
  payloadMatchesQuery,
  sortRecords,
} from './recordColumns';
import type { RenderHints } from './recordForm';
import type { Vectros } from '@vectros-ai/sdk';

type FieldDef = Vectros.FieldDef;

// `fieldType` stays a plain `string` (not the union) so tests can probe
// arbitrary types; cast at the boundary to satisfy the typed FieldDef.
const field = (fieldId: string, fieldType: string, extra: Partial<FieldDef> = {}): FieldDef => ({
  fieldId,
  fieldType: fieldType as FieldDef['fieldType'],
  ...extra,
});

describe('deriveValueColumns', () => {
  it('orders by renderHints.order, labels via hints, caps the count', () => {
    const fields = [
      field('c', 'string'),
      field('a', 'string', { filterable: true }),
      field('b', 'number'),
      field('blob', 'object'), // not form-displayable → excluded
    ];
    const hints: RenderHints = { a: { order: 1, label: 'Alpha' }, b: { order: 2 } };
    const cols = deriveValueColumns(fields, hints, 2);
    expect(cols.map((c) => c.fieldId)).toEqual(['a', 'b']);
    expect(cols[0]).toMatchObject({ label: 'Alpha', fieldType: 'string', filterable: true });
    expect(cols[1]).toMatchObject({ label: 'b', filterable: false }); // fieldId fallback
  });

  it('reports the inline flag per column, independently of filterable', () => {
    // The two flags answer different questions and a column can carry either,
    // both or neither — so this asserts the cross, not one flag standing in for
    // the other. `inline` says the schema keeps the field on the record row, so
    // a list read without the payload has a value to render; `filterable`
    // drives the filter affordance and happens to imply row-residency too,
    // which is why the doc tells a host to union them rather than read one.
    const fields = [
      field('plain', 'string'),
      field('inl', 'string', { inline: true }),
      field('filt', 'string', { filterable: true }),
      field('both', 'string', { inline: true, filterable: true }),
    ];
    const byId = Object.fromEntries(
      deriveValueColumns(fields, undefined, 10).map((c) => [c.fieldId, c]),
    );
    expect(byId['plain']).toMatchObject({ inline: false, filterable: false });
    expect(byId['inl']).toMatchObject({ inline: true, filterable: false });
    expect(byId['filt']).toMatchObject({ inline: false, filterable: true });
    expect(byId['both']).toMatchObject({ inline: true, filterable: true });
  });

  it('is empty when no displayable fields', () => {
    expect(deriveValueColumns([field('x', 'array')])).toEqual([]);
  });

  it('excludes the promoted headline field, freeing a slot for the next column', () => {
    const fields = [field('a', 'string'), field('b', 'string'), field('c', 'string')];
    const hints: RenderHints = { a: { order: 1 }, b: { order: 2 }, c: { order: 3 } };
    // Cap 2 with `a` promoted → `b`, `c` (the exclusion happens before the cap).
    const cols = deriveValueColumns(fields, hints, 2, 'a');
    expect(cols.map((c) => c.fieldId)).toEqual(['b', 'c']);
  });
});

// --- displayField promotion (renderHints pressure-test) ------------------
describe('findDisplayFieldId', () => {
  const fields = [field('id', 'string'), field('name', 'string'), field('age', 'number')];

  it('returns undefined with no hints, or when none is flagged', () => {
    expect(findDisplayFieldId(fields)).toBeUndefined();
    expect(findDisplayFieldId(fields, { name: { label: 'Name' } })).toBeUndefined();
    expect(findDisplayFieldId(fields, { name: { displayField: false } })).toBeUndefined();
  });

  it('returns the single flagged field', () => {
    expect(findDisplayFieldId(fields, { name: { displayField: true } })).toBe('name');
  });

  it('is deterministic when several are (mis)flagged: lowest order, then schema order', () => {
    // Two flagged: `age` has the lower order → wins despite later schema position.
    expect(
      findDisplayFieldId(fields, {
        name: { displayField: true, order: 5 },
        age: { displayField: true, order: 1 },
      }),
    ).toBe('age');
    // No orders → first in declared schema order wins.
    expect(
      findDisplayFieldId(fields, {
        age: { displayField: true },
        name: { displayField: true },
      }),
    ).toBe('name');
  });

  it('ignores a stale hint pointing at a field not in the schema', () => {
    expect(findDisplayFieldId(fields, { ghost: { displayField: true } })).toBeUndefined();
  });

  it('resolves a displayField flagged on a non-form-editable type (e.g. reference)', () => {
    const withRef = [...fields, field('owner', 'reference', { targetTypeName: 'user' })];
    expect(findDisplayFieldId(withRef, { owner: { displayField: true } })).toBe('owner');
  });
});

describe('filterableFieldIds', () => {
  it('returns only the filterable-flagged fields', () => {
    const fields = [
      field('a', 'string', { filterable: true }),
      field('b', 'string'),
      field('c', 'number', { filterable: true }),
    ];
    expect(filterableFieldIds(fields)).toEqual(['a', 'c']);
  });
});

describe('formatCellValue', () => {
  it('formats blanks, booleans, objects, and scalars', () => {
    expect(formatCellValue(undefined)).toBe('—');
    expect(formatCellValue(null)).toBe('—');
    expect(formatCellValue('')).toBe('—');
    expect(formatCellValue(true)).toBe('✓');
    expect(formatCellValue(false)).toBe('—');
    expect(formatCellValue(42)).toBe('42');
    expect(formatCellValue('hi')).toBe('hi');
    expect(formatCellValue({ a: 1 })).toBe('{"a":1}');
  });
});

describe('compareValues', () => {
  it('sorts numbers numerically, blanks last, strings by locale', () => {
    expect(compareValues(2, 10)).toBeLessThan(0); // numeric, not lexical
    expect(compareValues('apple', 'banana')).toBeLessThan(0);
    expect(compareValues(undefined, 5)).toBeGreaterThan(0); // blank last
    expect(compareValues(5, undefined)).toBeLessThan(0);
    expect(compareValues(undefined, null)).toBe(0);
    expect(compareValues(true, false)).toBeLessThan(0); // true first
  });
});

describe('sortRecords', () => {
  const rows = [{ n: 3 }, { n: 1 }, { n: 2 }];
  it('sorts ascending and descending by an accessor', () => {
    expect(sortRecords(rows, (r) => r.n, 'asc').map((r) => r.n)).toEqual([1, 2, 3]);
    expect(sortRecords(rows, (r) => r.n, 'desc').map((r) => r.n)).toEqual([3, 2, 1]);
  });

  it('is stable for ties and does not mutate the input', () => {
    const tied = [
      { id: 'a', k: 1 },
      { id: 'b', k: 1 },
      { id: 'c', k: 1 },
    ];
    expect(sortRecords(tied, (r) => r.k, 'asc').map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(tied[0]?.id).toBe('a'); // original untouched
  });
});

describe('payloadMatchesQuery', () => {
  const payload = { firstName: 'Alice', tier: 'gold', age: 42 };
  it('matches case-insensitively over the given fields', () => {
    expect(payloadMatchesQuery(payload, 'ali', ['firstName'])).toBe(true);
    expect(payloadMatchesQuery(payload, 'GOLD', ['tier'])).toBe(true);
    expect(payloadMatchesQuery(payload, '42', ['age'])).toBe(true);
  });
  it('ignores fields not in the list', () => {
    expect(payloadMatchesQuery(payload, 'gold', ['firstName'])).toBe(false);
  });
  it('an empty query matches everything; a missing payload matches nothing', () => {
    expect(payloadMatchesQuery(payload, '   ', ['firstName'])).toBe(true);
    expect(payloadMatchesQuery(undefined, 'x', ['firstName'])).toBe(false);
  });
});
