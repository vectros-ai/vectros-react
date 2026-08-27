// ---------------------------------------------------------------------------
// Schema-driven list columns + client-side sort/filter for a records-style
// list view (columns derived from the schema's primary fields; OOTB
// primitives). Pure + framework-free so the column derivation, value
// formatting, sort, and filter are unit-testable in isolation; the host page
// is a thin renderer over these.
//
// Headline/"display field" promotion: a schema may flag one field with
// the `displayField` renderHint — it becomes the linked primary column in the
// list (and the detail title), replacing the raw record `id` as the headline.
// `findDisplayFieldId` resolves it; the caller excludes it from the value
// columns (via `deriveValueColumns({ excludeFieldId })`) so it isn't duplicated.
// With no `displayField` hint the stable record `id` stays the linked column and
// these derived columns sit beside it.
// ---------------------------------------------------------------------------

import type { Vectros } from '@vectros-ai/sdk';
import { fieldLabel, orderedFormFields } from './recordForm';
import type { RenderHints } from './recordForm';

type FieldDef = Vectros.FieldDef;

/** Default cap on schema-derived value columns — keeps the table readable. */
export const DEFAULT_COLUMN_CAP = 4;

/**
 * The fieldId promoted to the headline/linked-primary column (and the detail
 * title) — the schema field whose `renderHints.displayField === true`.
 * At most one per schema; if several are (mis)flagged, the lowest-ordered wins
 * (then declared order), so the choice is deterministic. Returns undefined when
 * no field is flagged, or the flagged field isn't in `fields` (a stale hint).
 */
export function findDisplayFieldId(
  fields: ReadonlyArray<FieldDef>,
  hints?: RenderHints,
): string | undefined {
  if (!hints) return undefined;
  // Deterministic tie-break: renderHints.order asc (missing sorts last), then
  // declared schema order. Independent of field type — unlike the value columns,
  // a displayField may be any type (it's only ever read, never an input here).
  const flagged = fields
    .map((field, index) => ({ field, index, order: hints[field.fieldId]?.order }))
    .filter((e) => hints[e.field.fieldId]?.displayField === true)
    .sort((a, b) => {
      const ao = a.order ?? Number.POSITIVE_INFINITY;
      const bo = b.order ?? Number.POSITIVE_INFINITY;
      return ao !== bo ? ao - bo : a.index - b.index;
    });
  return flagged[0]?.field.fieldId;
}

/** A schema-derived value column for the records table. */
export interface RecordColumn {
  readonly fieldId: string;
  readonly label: string;
  readonly fieldType: string;
  /** Whether the field is flagged filterable (drives the filter affordance). */
  readonly filterable: boolean;
}

/**
 * The value columns for the records list: the form-displayable fields, ordered
 * by `renderHints.order` (see `orderedFormFields`), capped at `cap`, labelled
 * via `renderHints.label` (fallback `fieldId`). Empty when the schema declares
 * no displayable fields — the caller then falls back to id/status/index/updated.
 *
 * `excludeFieldId` drops one field (the headline/displayField, promoted to the
 * linked primary column) so it isn't rendered twice. Excluding before the cap
 * means a promoted headline frees a slot for the next value column.
 */
export function deriveValueColumns(
  fields: ReadonlyArray<FieldDef>,
  hints?: RenderHints,
  cap: number = DEFAULT_COLUMN_CAP,
  excludeFieldId?: string,
): RecordColumn[] {
  return orderedFormFields(fields, hints)
    .filter((field) => field.fieldId !== excludeFieldId)
    .slice(0, Math.max(0, cap))
    .map((field) => ({
      fieldId: field.fieldId,
      label: fieldLabel(field, hints),
      fieldType: field.fieldType,
      filterable: field.filterable === true,
    }));
}

/** The fieldIds the caller may filter on (schema `filterable` flag). */
export function filterableFieldIds(fields: ReadonlyArray<FieldDef>): string[] {
  return fields.filter((f) => f.filterable === true).map((f) => f.fieldId);
}

/** Treat undefined/null/empty-string as "blank" for formatting + sorting. */
function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * Render a record payload value as a table cell string. Booleans become a
 * check/dash, blanks an em-dash, objects/arrays a compact JSON string, and
 * everything else its `String()` form.
 */
export function formatCellValue(value: unknown): string {
  if (isBlank(value)) return '—';
  if (typeof value === 'boolean') return value ? '✓' : '—';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * Comparator for two payload values: numbers numerically, booleans true-first,
 * everything else by locale string order; blanks always sort last.
 */
export function compareValues(a: unknown, b: unknown): number {
  const ab = isBlank(a);
  const bb = isBlank(b);
  if (ab || bb) return ab === bb ? 0 : ab ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? -1 : 1;
  return String(a).localeCompare(String(b));
}

export type SortDirection = 'asc' | 'desc';

/**
 * Stably sort records by a value accessor + direction. Ties keep their original
 * order (so toggling direction is predictable). Does not mutate the input.
 */
export function sortRecords<T>(
  records: ReadonlyArray<T>,
  accessor: (record: T) => unknown,
  direction: SortDirection,
): T[] {
  const sign = direction === 'desc' ? -1 : 1;
  return records
    .map((record, index) => ({ record, index }))
    .sort((x, y) => {
      const cmp = compareValues(accessor(x.record), accessor(y.record));
      return cmp !== 0 ? sign * cmp : x.index - y.index;
    })
    .map((entry) => entry.record);
}

/**
 * Whether a payload matches a free-text query against the given fieldIds
 * (case-insensitive substring over each field's formatted value). An empty
 * query matches everything.
 */
export function payloadMatchesQuery(
  payload: Record<string, unknown> | undefined,
  query: string,
  fieldIds: ReadonlyArray<string>,
): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  if (!payload) return false;
  return fieldIds.some((id) => {
    const value = payload[id];
    return !isBlank(value) && formatCellValue(value).toLowerCase().includes(q);
  });
}
