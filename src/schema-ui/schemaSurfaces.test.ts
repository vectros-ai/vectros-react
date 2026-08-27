// ---------------------------------------------------------------------------
// schemaSurfaces tests — surface filtering + typeName dedup.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { distinctTypes, schemasForSurface } from './schemaSurfaces';

describe('schemasForSurface', () => {
  it('keeps only schemas whose allowedSurfaces includes the given surface', () => {
    const result = schemasForSurface(
      [
        { typeName: 'patient', allowedSurfaces: ['record'] },
        { typeName: 'contract', allowedSurfaces: ['document'] },
        { typeName: 'both', allowedSurfaces: ['record', 'document'] },
      ],
      'record',
    );
    expect(result.map((s) => s.typeName)).toEqual(['patient', 'both']);
  });

  it('drops a schema with no typeName', () => {
    const result = schemasForSurface([{ allowedSurfaces: ['record'] }], 'record');
    expect(result).toEqual([]);
  });
});

describe('distinctTypes', () => {
  it('keeps the first schema for each distinct typeName', () => {
    const base = { id: 'base_1', typeName: 'patient' };
    const variant = { id: 'variant_1', typeName: 'patient', basedOn: 'base_1' };
    const other = { id: 'other_1', typeName: 'employee' };
    expect(distinctTypes([base, variant, other])).toEqual([base, other]);
  });

  it('passes through a list with no duplicate typeNames unchanged', () => {
    const a = { id: 'a', typeName: 'patient' };
    const b = { id: 'b', typeName: 'employee' };
    expect(distinctTypes([a, b])).toEqual([a, b]);
  });
});
