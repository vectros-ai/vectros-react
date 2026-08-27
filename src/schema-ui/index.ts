// ---------------------------------------------------------------------------
// Barrel exports for the schema-ui module — schema-driven record form/list
// rendering. A schema's `FieldDef[]` + `renderHints` drive typed form inputs
// and derived table columns generically, so a host app builds its own record
// editor/list page around these primitives instead of hand-rolling per-type
// forms. See RecordFormFields.tsx's header for the raw-JSON-source-of-truth
// contract this module assumes.
// ---------------------------------------------------------------------------

export { schemasForSurface, distinctTypes } from './schemaSurfaces';
export type { TypedSchema } from './schemaSurfaces';

export {
  fieldLabel,
  fieldHelpText,
  fieldWidget,
  orderedFormFields,
  groupFieldsBySection,
  FORM_EDITABLE_FIELD_TYPES,
  temporalInputKind,
  toDateInputValue,
  toDateTimeLocalInputValue,
  isFormEditable,
  isReservedPayloadKey,
  stripReservedPayloadKeys,
  coerceFieldValue,
  unstructuredKeys,
  enumOptions,
  validateFields,
  withField,
} from './recordForm';
export type { RenderHints, FieldSection, FieldErrorKind, FieldErrors } from './recordForm';

export {
  DEFAULT_COLUMN_CAP,
  findDisplayFieldId,
  deriveValueColumns,
  filterableFieldIds,
  formatCellValue,
  compareValues,
  sortRecords,
  payloadMatchesQuery,
} from './recordColumns';
export type { RecordColumn, SortDirection } from './recordColumns';

export { RecordFormFields } from './RecordFormFields';
export type { RecordFormFieldsProps } from './RecordFormFields';
