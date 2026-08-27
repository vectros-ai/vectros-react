// ---------------------------------------------------------------------------
// RecordFormFields — the schema-driven form view of a record editor.
// Presentational: it renders a typed input per schema field and
// reports edits via `onChange(field, input)`; the host coerces + writes the
// value back through its own source of truth (e.g. a raw-JSON editor).
//
// Field types it renders: string · number · boolean · date · enum. Complex
// types (array/object/relationship) and schema-undescribed ("unstructured")
// keys are not editable here — they're listed as a hint to use a raw view,
// so no payload data is ever silently un-editable.
// ---------------------------------------------------------------------------

import {
  Box,
  Chip,
  FormControl,
  FormControlLabel,
  FormHelperText,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import type { SelectChangeEvent } from '@mui/material';
import { FormattedMessage, useIntl } from 'react-intl';

import type { Vectros } from '@vectros-ai/sdk';
import {
  enumOptions,
  fieldHelpText,
  fieldLabel,
  fieldWidget,
  groupFieldsBySection,
  isFormEditable,
  orderedFormFields,
  temporalInputKind,
  toDateInputValue,
  toDateTimeLocalInputValue,
  unstructuredKeys,
} from './recordForm';
import type { FieldErrors, RenderHints } from './recordForm';

type FieldDef = Vectros.FieldDef;

export interface RecordFormFieldsProps {
  readonly fields: ReadonlyArray<FieldDef>;
  readonly value: Record<string, unknown>;
  readonly errors: FieldErrors;
  /** Schema `renderHints` (label/order/section/helpText/widget), keyed by
   *  fieldId. Optional — the form renders identically without them. */
  readonly renderHints?: RenderHints | undefined;
  /** Message id for the not-editable-here (complex/undeclared) fields note.
   *  Defaults to `recordForm.rawOnlyNote` — hosts without a raw-JSON view
   *  pass their own. */
  readonly rawOnlyNoteId?: string | undefined;
  /** Reports an edit with the field's raw input (string from text/date/enum,
   *  boolean from a switch); the host coerces to the typed value. */
  readonly onChange: (field: FieldDef, input: string | boolean) => void;
}

export function RecordFormFields({
  fields,
  value,
  errors,
  renderHints,
  rawOnlyNoteId,
  onChange,
}: RecordFormFieldsProps): React.JSX.Element {
  const intl = useIntl();

  // Ordered by renderHints.order, then grouped by renderHints.section.
  const sections = groupFieldsBySection(orderedFormFields(fields, renderHints), renderHints);
  const complexFieldIds = fields.filter((f) => !isFormEditable(f)).map((f) => f.fieldId);
  const extras = unstructuredKeys(fields, value);
  const rawOnlyKeys = [...complexFieldIds, ...extras];

  const helperFor = (field: FieldDef): string | undefined => {
    if (errors[field.fieldId] === 'required') {
      return intl.formatMessage({ id: 'recordForm.errorRequired' });
    }
    if (errors[field.fieldId] === 'enum') {
      return intl.formatMessage({ id: 'recordForm.errorEnum' });
    }
    return fieldHelpText(field, renderHints);
  };

  const renderField = (field: FieldDef): React.JSX.Element => {
    const hasError = field.fieldId in errors;
    const helper = helperFor(field);
    const current = value[field.fieldId];
    const label = fieldLabel(field, renderHints);
    const labelWithReq = `${label}${field.required ? ' *' : ''}`;

    if (field.fieldType === 'boolean') {
      return (
        <Box key={field.fieldId}>
          <FormControlLabel
            control={
              <Switch
                checked={current === true}
                onChange={(e) => onChange(field, e.target.checked)}
              />
            }
            label={label}
          />
          {helper && <FormHelperText error={hasError}>{helper}</FormHelperText>}
        </Box>
      );
    }

    if (field.fieldType === 'enum') {
      const options = enumOptions(field);
      return (
        <FormControl key={field.fieldId} size="small" error={hasError} sx={{ maxWidth: 480 }}>
          <InputLabel id={`field-${field.fieldId}-label`}>{labelWithReq}</InputLabel>
          <Select
            labelId={`field-${field.fieldId}-label`}
            label={labelWithReq}
            value={current === undefined || current === null ? '' : String(current)}
            onChange={(e: SelectChangeEvent) => onChange(field, e.target.value)}
          >
            {!field.required && (
              <MenuItem value="">
                <em>
                  <FormattedMessage id="recordForm.enumNone" />
                </em>
              </MenuItem>
            )}
            {options.map((opt) => (
              <MenuItem key={opt} value={opt}>
                {opt}
              </MenuItem>
            ))}
          </Select>
          {helper && <FormHelperText>{helper}</FormHelperText>}
        </FormControl>
      );
    }

    // string · number · date · datetime. A `textarea` widget hint renders a
    // multiline input. Temporal fields render a native date / datetime-local
    // picker (see temporalInputKind), with the stored value normalized to the
    // input's expected format.
    const temporal = temporalInputKind(field, renderHints);
    const isTextarea =
      field.fieldType === 'string' && fieldWidget(field, renderHints) === 'textarea';
    const inputType =
      temporal === 'datetime'
        ? 'datetime-local'
        : temporal === 'date'
          ? 'date'
          : field.fieldType === 'number'
            ? 'number'
            : 'text';
    const displayValue =
      temporal === 'datetime'
        ? toDateTimeLocalInputValue(current)
        : temporal === 'date'
          ? toDateInputValue(current)
          : current === undefined || current === null
            ? ''
            : String(current);
    return (
      <TextField
        key={field.fieldId}
        label={labelWithReq}
        type={isTextarea ? undefined : inputType}
        multiline={isTextarea}
        minRows={isTextarea ? 3 : undefined}
        value={displayValue}
        onChange={(e) => onChange(field, e.target.value)}
        error={hasError}
        helperText={helper}
        size="small"
        sx={{ maxWidth: 480 }}
        // Temporal inputs always show a format placeholder → keep the label shrunk.
        slotProps={temporal !== null ? { inputLabel: { shrink: true } } : undefined}
      />
    );
  };

  return (
    <Stack spacing={3}>
      {sections.map((group) => (
        <Stack key={group.section ?? '__nosection__'} spacing={3}>
          {group.section && (
            <Typography variant="subtitle2" sx={{ fontWeight: 700, color: 'text.secondary' }}>
              {group.section}
            </Typography>
          )}
          {group.fields.map(renderField)}
        </Stack>
      ))}

      {rawOnlyKeys.length > 0 && (
        <Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            <FormattedMessage id={rawOnlyNoteId ?? 'recordForm.rawOnlyNote'} />
          </Typography>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
            {rawOnlyKeys.map((k) => (
              <Chip key={k} label={k} size="small" variant="outlined" />
            ))}
          </Stack>
        </Box>
      )}
    </Stack>
  );
}
