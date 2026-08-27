// ---------------------------------------------------------------------------
// Schema-driven form helpers — the pure logic behind a schema-driven record
// editor's form view (dual-mode editor). Kept free of React/MUI so the
// field-type mapping, value coercion, and validation are unit-testable in
// isolation.
//
// Contract with a raw view: the raw JSON text is the single source of truth.
// The form view is a typed PROJECTION of the parsed payload — it can only be
// shown when the raw text parses to an object, and every form edit writes a
// coerced value back into that object (which re-serializes to raw). Schemas are
// non-strict, so a payload may carry keys the schema doesn't describe; those are
// surfaced as "unstructured" and remain editable only via the raw view.
// ---------------------------------------------------------------------------

import type { Vectros } from '@vectros-ai/sdk';

type FieldDef = Vectros.FieldDef;

/**
 * Per-field UI rendering hints (schema `renderHints`, keyed by `fieldId`):
 * `label` / `widget` / `order` / `section` / `helpText`. All advisory — every
 * accessor below falls back gracefully when a hint (or the whole map) is absent,
 * so the form renders identically for a hint-less schema.
 */
export type RenderHints = Readonly<Record<string, Vectros.RenderHintDef>>;

/** A non-empty string, or undefined — collapses `''`/whitespace to undefined. */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/** The display label for a field: `renderHints.label`, else the raw `fieldId`. */
export function fieldLabel(field: FieldDef, hints?: RenderHints): string {
  return nonEmpty(hints?.[field.fieldId]?.label) ?? field.fieldId;
}

/**
 * The non-error helper text for a field: `renderHints.helpText`, else the
 * schema's `description`, else undefined. (Validation-error text is supplied by
 * the component, which owns the i18n catalog.)
 */
export function fieldHelpText(field: FieldDef, hints?: RenderHints): string | undefined {
  return nonEmpty(hints?.[field.fieldId]?.helpText) ?? field.description;
}

/** The widget hint for a field (e.g. `'textarea'`), or undefined. */
export function fieldWidget(field: FieldDef, hints?: RenderHints): string | undefined {
  return nonEmpty(hints?.[field.fieldId]?.widget);
}

/**
 * The form-editable fields, ordered by `renderHints.order` (ascending; missing
 * order sorts last). Stable for ties — fields with equal/absent order keep their
 * declared schema order.
 */
export function orderedFormFields(
  fields: ReadonlyArray<FieldDef>,
  hints?: RenderHints,
): FieldDef[] {
  return fields
    .filter(isFormEditable)
    .map((field, index) => ({ field, index, order: hints?.[field.fieldId]?.order }))
    .sort((a, b) => {
      const ao = a.order ?? Number.POSITIVE_INFINITY;
      const bo = b.order ?? Number.POSITIVE_INFINITY;
      return ao !== bo ? ao - bo : a.index - b.index;
    })
    .map((entry) => entry.field);
}

/** A run of fields under one `renderHints.section` (undefined = no section). */
export interface FieldSection {
  readonly section: string | undefined;
  readonly fields: ReadonlyArray<FieldDef>;
}

/**
 * Group already-ordered fields by `renderHints.section`, preserving section
 * order by first appearance (so a section heading is emitted once, even if its
 * fields aren't contiguous). Un-sectioned fields collect into a single
 * `section: undefined` group at its first-appearance position.
 */
export function groupFieldsBySection(
  orderedFields: ReadonlyArray<FieldDef>,
  hints?: RenderHints,
): FieldSection[] {
  const groups: { section: string | undefined; fields: FieldDef[] }[] = [];
  const byKey = new Map<string, { section: string | undefined; fields: FieldDef[] }>();
  for (const field of orderedFields) {
    const section = nonEmpty(hints?.[field.fieldId]?.section);
    const key = section ?? '';
    let group = byKey.get(key);
    if (!group) {
      group = { section, fields: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.fields.push(field);
  }
  return groups;
}

/**
 * Field types the form view renders as a typed input. Anything else
 * (`array`, `object`, relationship references, or an unknown future type)
 * falls back to the raw view — see `isFormEditable`.
 */
export const FORM_EDITABLE_FIELD_TYPES = new Set([
  'string',
  'number',
  'boolean',
  'date',
  'datetime',
  'enum',
]);

/**
 * The temporal input kind for a date-ish field, or null if the field isn't
 * temporal. The schema doesn't yet distinguish a calendar date from a timestamp
 * — it only has `date` — so a bare `date` field DEFAULTS to date+time (most
 * record timestamps carry a time). Overrides, both forward-compatible:
 *   - a `date` widget hint pins a field to date-only;
 *   - a future `datetime` field type renders date+time directly.
 * When the schema grows a real date/datetime split, this resolves correctly
 * with no caller changes. (`datetime` isn't in the current `FieldType` union, so
 * the future-type check is a deliberate widening to a string.)
 */
export function temporalInputKind(
  field: FieldDef,
  hints?: RenderHints,
): 'date' | 'datetime' | null {
  if ((field.fieldType as string) === 'datetime') return 'datetime';
  if (field.fieldType !== 'date') return null;
  // A `date` widget hint is the escape hatch to keep a field date-only.
  if (fieldWidget(field, hints) === 'date') return 'date';
  return 'datetime';
}

/** Normalize a stored value to a date input's `YYYY-MM-DD` (empty if unparseable). */
export function toDateInputValue(value: unknown): string {
  if (typeof value !== 'string') return '';
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return match?.[1] ?? '';
}

/**
 * Normalize a stored value to a datetime-local input's `YYYY-MM-DDTHH:mm`. A
 * date-only value is padded to midnight; a longer timestamp is trimmed to
 * minutes. No timezone conversion — the wall-clock shown is the wall-clock
 * stored, so the value round-trips through the input without drift.
 */
export function toDateTimeLocalInputValue(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  const dateOnly = /^(\d{4}-\d{2}-\d{2})$/.exec(trimmed);
  if (dateOnly) return `${dateOnly[1] ?? ''}T00:00`;
  const dateTime = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(trimmed);
  if (dateTime) return `${dateTime[1] ?? ''}T${dateTime[2] ?? ''}`;
  return '';
}

/** Whether a field's type has a first-class typed input in the form view. */
export function isFormEditable(field: FieldDef): boolean {
  return FORM_EDITABLE_FIELD_TYPES.has(field.fieldType);
}

/**
 * Payload keys reserved by the platform. The ownership identifiers and the
 * record's externalId are first-class TOP-LEVEL record fields, not payload
 * entries — the write API rejects any payload that carries one of them. So a
 * form-view editor never renders an input for a schema field named like a
 * reserved key, and strips these keys from the body before every save (and
 * when seeding the editor from a loaded record, in case an older write stored
 * one inside the payload). externalId is captured by its own dedicated
 * top-level control.
 *
 * This client-side strip is a top-level, case-sensitive UX nicety — the SERVER
 * is the authority that rejects reserved keys; the strip just spares the user a
 * round-trip and a confusing error.
 */
const RESERVED_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  'externalId',
  'partnerUserId',
  'userId',
  'scopes',
]);

/** Whether `key` is a reserved top-level identifier that must not live in a payload. */
export function isReservedPayloadKey(key: string): boolean {
  return RESERVED_PAYLOAD_KEYS.has(key);
}

/** A copy of `payload` with every reserved (top-level) identifier key removed. */
export function stripReservedPayloadKeys(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!RESERVED_PAYLOAD_KEYS.has(key)) next[key] = value;
  }
  return next;
}

/**
 * Coerce a raw input value (string from a text/date/enum input, boolean from a
 * switch) into the typed value stored in the payload. Returns `undefined` to
 * signal "remove this key" (an empty string for a non-string field, so the
 * payload doesn't carry empty-string noise where a number/date is expected).
 */
export function coerceFieldValue(field: FieldDef, input: string | boolean): unknown {
  if (field.fieldType === 'boolean') {
    return typeof input === 'boolean' ? input : input === 'true';
  }
  // From here on the input is a string from a text-like control.
  const text = typeof input === 'string' ? input : String(input);
  if (field.fieldType === 'number') {
    if (text.trim() === '') return undefined;
    const n = Number(text);
    return Number.isNaN(n) ? text : n; // keep the raw text if not yet numeric
  }
  if (text === '' && field.fieldType !== 'string') return undefined;
  return text; // string, date, enum → stored as-is
}

/** The set of fieldIds the schema describes. */
function describedKeys(fields: ReadonlyArray<FieldDef>): Set<string> {
  return new Set(fields.map((f) => f.fieldId));
}

/**
 * Keys present in the payload that the schema does NOT describe — the
 * "unstructured" extras shown read-only in the form view (editable via raw).
 */
export function unstructuredKeys(
  fields: ReadonlyArray<FieldDef>,
  payload: Record<string, unknown>,
): string[] {
  const described = describedKeys(fields);
  return Object.keys(payload)
    .filter((k) => !described.has(k))
    .sort();
}

/** A per-field validation error, keyed by fieldId → message-key discriminator. */
export type FieldErrorKind = 'required' | 'enum';
export type FieldErrors = Readonly<Record<string, FieldErrorKind>>;

/** Whether a value counts as "present" for a required check. */
function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

/** Allowed string values for an enum field (from `enumValues[].value`). */
export function enumOptions(field: FieldDef): string[] {
  if (!field.enumValues) return [];
  return field.enumValues
    .map((entry) => {
      // enumValues entries are loosely typed objects; accept {value} or a bare
      // string-ish value.
      if (entry && typeof entry === 'object' && 'value' in entry) {
        return String((entry as { value: unknown }).value);
      }
      return String(entry);
    })
    .filter((v) => v !== 'undefined' && v !== '');
}

/**
 * Client-side validation for the typed fields: required-presence and enum
 * membership. The server remains the authority for everything else (length,
 * pattern, numeric range) — a rejected save surfaces through the save-error
 * path. Only fields the form actually renders are checked.
 */
export function validateFields(
  fields: ReadonlyArray<FieldDef>,
  payload: Record<string, unknown>,
): FieldErrors {
  const errors: Record<string, FieldErrorKind> = {};
  for (const field of fields) {
    if (!isFormEditable(field)) continue;
    const value = payload[field.fieldId];
    if (field.required && !isPresent(value)) {
      errors[field.fieldId] = 'required';
      continue;
    }
    if (field.fieldType === 'enum' && isPresent(value)) {
      const options = enumOptions(field);
      if (options.length > 0 && !options.includes(String(value))) {
        errors[field.fieldId] = 'enum';
      }
    }
  }
  return errors;
}

/** Immutably set (or delete, when value is undefined) a key in a payload. */
export function withField(
  payload: Record<string, unknown>,
  fieldId: string,
  value: unknown,
): Record<string, unknown> {
  const next = { ...payload };
  if (value === undefined) {
    delete next[fieldId];
  } else {
    next[fieldId] = value;
  }
  return next;
}
