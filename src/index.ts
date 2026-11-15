// ---------------------------------------------------------------------------
// @vectros-ai/react — public barrel.
//
// The shared React toolkit for Vectros reference apps: a provider-agnostic
// auth adapter (`AuthProviderAdapter`) with a Cognito reference implementation,
// the Vectros API token cache (keyed per tenant + context), MFA enrollment,
// the auth/layout UI primitives, and schema-driven record form/list rendering.
//
// More surface (UI primitives, IntlProvider, switchers) is re-exported here as
// each module lands during the admin-app extraction.
// ---------------------------------------------------------------------------

// The headless half (auth, token cache, inference, schema logic, i18n). It is
// also published alone as `@vectros-ai/react/core` for apps without MUI.
export * from './core';

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
export { ApiErrorAlert } from './components/ApiErrorAlert';
export type { ApiErrorAlertProps } from './components/ApiErrorAlert';
export { RequestIdCaption } from './components/RequestIdCaption';
export type { RequestIdCaptionProps } from './components/RequestIdCaption';
export { SearchModeToggle } from './components/search/SearchModeToggle';
export type { SearchModeToggleProps, SearchMode } from './components/search/SearchModeToggle';
export { SearchResultCard } from './components/search/SearchResultCard';
export type { SearchResultCardProps } from './components/search/SearchResultCard';

// Schema-driven record form fields (MUI). The schema logic it renders from is
// part of the headless entry above. `RecordFormFields` renders react-intl
// messages under the `recordForm.*` ids shipped in `baseMessagesEn`.
export { RecordFormFields } from './schema-ui/RecordFormFields';
export type { RecordFormFieldsProps } from './schema-ui/RecordFormFields';
