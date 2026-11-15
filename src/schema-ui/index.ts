// ---------------------------------------------------------------------------
// Barrel exports for the schema-ui module: schema-driven record form/list
// rendering. The logic is in ./headless (also part of the `/core` entry);
// RecordFormFields renders it with MUI. See RecordFormFields.tsx's header for
// the raw-JSON-source-of-truth contract this module assumes.
// ---------------------------------------------------------------------------

export * from './headless';
export { RecordFormFields } from './RecordFormFields';
export type { RecordFormFieldsProps } from './RecordFormFields';
