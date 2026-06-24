// ---------------------------------------------------------------------------
// authErrorToMessage — single shared translator from auth-layer errors to
// user-facing message strings.
//
// Replaces the 4-way duplication of `errorToMessage` that existed in
// LoginPage / AcceptPage / ConfirmPage / ForgotPasswordPage after each page
// was migrated individually to react-intl; this consolidation is the cleanup.
//
// **Contract:**
//   - Provider-agnostic: pages dispatch on `AuthError.code` (the normalized
//     AuthErrorCode) — NEVER on provider-native error names.
//   - PASSWORD_POLICY_VIOLATION's `e.message` (the rule that failed) is
//     surfaced verbatim when present. The catalog's generic fallback only
//     fires when the provider didn't supply a specific message.
//   - Non-AuthError throwables (network glitches, bugs, etc.) map to the
//     `auth.errors.UNKNOWN` catalog entry. No internal details surfaced.
//
// Tests verify each branch: AuthError with known code, AuthError with
// PASSWORD_POLICY_VIOLATION + message, AuthError with unknown code (should
// still work because the catalog has every AuthErrorCode), and non-AuthError
// throwables.
// ---------------------------------------------------------------------------

import type { IntlShape } from 'react-intl';

import { AuthError } from './errors';

export function authErrorToMessage(intl: IntlShape, e: unknown): string {
  if (e instanceof AuthError) {
    if (e.code === 'PASSWORD_POLICY_VIOLATION' && e.message) return e.message;
    return intl.formatMessage({ id: `auth.errors.${e.code}` });
  }
  return intl.formatMessage({ id: 'auth.errors.UNKNOWN' });
}
