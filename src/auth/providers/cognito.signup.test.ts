// ---------------------------------------------------------------------------
// CognitoAuthProvider.signUp — error mapping.
//
// Focused on the one branch this file exists to pin: Amplify's
// `UsernameExistsException` (a signUp collision — an identity for this email
// already exists in the pool) must normalize to `AuthError('USER_ALREADY_EXISTS')`,
// not fall through to the generic `UNKNOWN` default. Consumers dispatch on
// that specific code to offer a "sign in instead" recovery path rather than
// a dead-end generic error.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the aws-amplify/auth surface the provider imports. Only signUp
// matters here; the rest are inert stubs so the module loads.
vi.mock('aws-amplify/auth', () => ({
  signIn: vi.fn(),
  signOut: vi.fn(),
  confirmSignIn: vi.fn(),
  confirmResetPassword: vi.fn(),
  confirmSignUp: vi.fn(),
  fetchAuthSession: vi.fn(),
  fetchMFAPreference: vi.fn(),
  fetchUserAttributes: vi.fn(),
  getCurrentUser: vi.fn(),
  resendSignUpCode: vi.fn(),
  resetPassword: vi.fn(),
  setUpTOTP: vi.fn(),
  signUp: vi.fn(),
  updateMFAPreference: vi.fn(),
  updatePassword: vi.fn(),
  verifyTOTPSetup: vi.fn(),
}));

import { signUp as amplifySignUp } from 'aws-amplify/auth';

import { CognitoAuthProvider } from './cognito';

const mockSignUp = vi.mocked(amplifySignUp);

/** An Error with a Cognito-style `name`, as Amplify throws. */
function named(name: string, message = name): Error {
  return Object.assign(new Error(message), { name });
}

const SIGNUP_INPUT = {
  email: 'invitee@example.com',
  password: 'pw',
  firstName: 'Ivy',
  lastName: 'Invitee',
};

function provider(): CognitoAuthProvider {
  return new CognitoAuthProvider({ developerApiBase: 'https://api.test', productName: 'Test' });
}

describe('CognitoAuthProvider.signUp — error mapping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps UsernameExistsException to USER_ALREADY_EXISTS', async () => {
    mockSignUp.mockRejectedValue(
      named('UsernameExistsException', 'An account with the given email already exists.'),
    );

    await expect(provider().signUp(SIGNUP_INPUT)).rejects.toMatchObject({
      code: 'USER_ALREADY_EXISTS',
      message: 'An account with the given email already exists.',
    });
  });

  it('still maps an unrelated failure to UNKNOWN (control)', async () => {
    mockSignUp.mockRejectedValue(named('InternalErrorException', 'boom'));

    await expect(provider().signUp(SIGNUP_INPUT)).rejects.toMatchObject({ code: 'UNKNOWN' });
  });
});
