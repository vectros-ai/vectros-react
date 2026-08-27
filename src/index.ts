// ---------------------------------------------------------------------------
// @vectros-ai/react — public barrel.
//
// The shared React toolkit for Vectros reference apps: a provider-agnostic
// auth adapter (`AuthProviderAdapter`) with a Cognito reference implementation,
// the partner-API token cache (keyed per tenant + context), MFA enrollment,
// the auth/layout UI primitives, and schema-driven record form/list rendering.
//
// More surface (UI primitives, IntlProvider, switchers) is re-exported here as
// each module lands during the admin-app extraction.
// ---------------------------------------------------------------------------

export * from './auth';

// UI primitives (presentational; brand/copy injected by the host app).
export { AuthCard } from './components/AuthCard';
export type { AuthCardProps } from './components/AuthCard';
export { PasswordField } from './components/PasswordField';
export type { PasswordFieldProps } from './components/PasswordField';
export { default as PasswordStrengthMeter } from './components/PasswordStrengthMeter';
export type { PasswordStrengthMeterProps } from './components/PasswordStrengthMeter';
export { RequireAuth } from './components/RequireAuth';
export type { RequireAuthProps } from './components/RequireAuth';
export { RequireScope } from './components/RequireScope';
export type { RequireScopeProps } from './components/RequireScope';
export { ErrorBoundary } from './components/ErrorBoundary';
export type { ErrorBoundaryProps } from './components/ErrorBoundary';
export { AppLayout } from './components/AppLayout';
export type { AppLayoutProps, NavItemSpec } from './components/AppLayout';
export { TotpEnrollmentWizard } from './components/mfa/TotpEnrollmentWizard';
export type { TotpEnrollmentWizardProps } from './components/mfa/TotpEnrollmentWizard';

// Data-plane UI primitives (presentational; copy injected by the host app).
export { LoadingBlock } from './components/LoadingBlock';
export type { LoadingBlockProps } from './components/LoadingBlock';
export { SubmitButton } from './components/SubmitButton';
export type { SubmitButtonProps } from './components/SubmitButton';
export { MetaList, MetaRow } from './components/MetaList';
export type { MetaListProps, MetaRowProps } from './components/MetaList';
export { ConfirmDialog } from './components/ConfirmDialog';
export type { ConfirmDialogProps } from './components/ConfirmDialog';
export { VersionUpdateBanner } from './components/VersionUpdateBanner';
export type { VersionUpdateBannerProps } from './components/VersionUpdateBanner';

// Schema-driven record UI — typed form inputs + derived list columns from a
// schema's `FieldDef[]`/`renderHints` (see schema-ui/index.ts for the full
// surface). `RecordFormFields` renders react-intl messages under the
// `recordForm.*` ids shipped in this package's base catalog (`baseMessagesEn`
// below) — a host merging its own catalog over the base gets them for free.
export * from './schema-ui';

// Streaming SSE state for chat/RAG/document-ask inference surfaces (see
// inference/index.ts). Endpoint-agnostic — a host supplies the SDK call as a
// runner thunk (`useInferenceStream`'s own doc comment shows the RAG shape).
export * from './inference';

// i18n — catalog-agnostic react-intl wrapper (the app supplies its catalog).
export { IntlProvider, I18N_DEFAULT_LOCALE } from './i18n/IntlProvider';
export type { IntlProviderProps, MessagesByLocale } from './i18n/IntlProvider';

// The package's default English strings for its OWN components (the AppLayout
// chrome, PasswordField, and the MFA surface). Consuming apps merge their own
// catalog OVER this so they never hand-copy these keys (which drifts):
//   const MESSAGES = { en: { ...baseMessagesEn, ...appMessagesEn } };
// App-defined keys win on collision. Add a locale by exporting its companion.
export { default as baseMessagesEn } from './i18n/messages.en.json';
