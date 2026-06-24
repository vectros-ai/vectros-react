// ---------------------------------------------------------------------------
// AuthError — provider-agnostic error type thrown by AuthProviderAdapter
// implementations.
//
// The abstraction depends on every concrete provider (CognitoAuthProvider,
// Auth0AuthProvider, etc.) translating its SDK's error vocabulary into this
// normalized form. Otherwise, every page consuming useAuth() would have to
// know which provider is underneath — defeating the abstraction.
//
// The code set deliberately covers the GENERAL cases — invalid credentials,
// pending confirmation, rate-limit, etc. — but is open to extension. Partner
// forks adding new providers may extend the AuthErrorCode union (carefully,
// since downstream consumers will only handle codes they know about).
// ---------------------------------------------------------------------------

/**
 * Normalized error codes shared across auth providers. Consumers
 * (LoginPage, ConfirmPage, etc.) pattern-match on these codes to show the
 * right user-facing message.
 *
 * IMPORTANT: `INVALID_CREDENTIALS` deliberately collapses both
 * "wrong password" and "user does not exist" — leaking the distinction
 * enables user-enumeration attacks. Provider adapters should map both
 * underlying errors to this code.
 */
export type AuthErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'USER_NOT_CONFIRMED'
  | 'CODE_MISMATCH'
  | 'EXPIRED_CODE'
  | 'PASSWORD_POLICY_VIOLATION'
  | 'LIMIT_EXCEEDED'
  | 'NETWORK_ERROR'
  | 'UNKNOWN';

/**
 * Concrete error subclass used everywhere in the auth layer. The `message`
 * field preserves the underlying provider's text (useful for diagnostics +
 * for codes like PASSWORD_POLICY_VIOLATION where the specific rule that
 * failed is in the message); the `code` field is what pages dispatch on.
 */
export class AuthError extends Error {
  override readonly name = 'AuthError';

  constructor(
    public readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    // Ensure prototype is preserved across the constructor boundary in
    // ES5-down-compiled environments. Harmless on ES2022+; defensive.
    Object.setPrototypeOf(this, AuthError.prototype);
  }
}

/** Type guard. Useful at error boundaries: `if (isAuthError(e)) ...`. */
export function isAuthError(e: unknown): e is AuthError {
  return e instanceof AuthError;
}
