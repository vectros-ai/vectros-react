// ---------------------------------------------------------------------------
// Schema-surface filtering — one place for "which schemas define types on THIS
// surface?". A schema declares, via `allowedSurfaces`, which typed surfaces
// may bind it (record, document, user, entity — always present, required at
// write time; identity entities in every namespace bind under the single
// `entity` surface). A records view must only offer record-surface types and
// a documents view only document-surface types; without the filter, a
// document-only type leaks into the records type picker (and vice versa) and
// every interaction with it 4xxs against the API.
//
// Kept framework-free so it is unit-testable in isolation.
// ---------------------------------------------------------------------------

import type { Vectros } from '@vectros-ai/sdk';

/** A schema usable as a type on some surface (its `typeName` is present). */
export type TypedSchema = Vectros.SchemaResponse & { typeName: string };

/**
 * The schemas that define types on `surface`: those with a `typeName` whose
 * `allowedSurfaces` includes it. Declared order is preserved.
 */
export function schemasForSurface(
  schemas: ReadonlyArray<Vectros.SchemaResponse>,
  surface: 'record' | 'document',
): TypedSchema[] {
  return schemas.filter(
    (s): s is TypedSchema =>
      typeof s.typeName === 'string' &&
      (s.allowedSurfaces ?? []).some((declared) => declared === surface),
  );
}

/**
 * Collapse to one entry per distinct `typeName` (first occurrence wins).
 *
 * A `typeName` can have several schemas: a lineage's shared base plus a
 * caller's own `basedOn` variant. A TYPE picker built directly off the
 * raw list would render one option per schema row — duplicate React keys
 * (both rows share the same `typeName`) collapsed to a single, unselectable
 * value. Callers that need "the record type" pick from this deduped list, then
 * resolve the caller's own specific schema for that type via the
 * `recordType`-filtered lookup (which the API already shadows by ownership),
 * never by re-matching `typeName` against this raw array.
 */
export function distinctTypes<T extends TypedSchema>(schemas: ReadonlyArray<T>): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const s of schemas) {
    if (seen.has(s.typeName)) continue;
    seen.add(s.typeName);
    result.push(s);
  }
  return result;
}
