// ---------------------------------------------------------------------------
// CognitoAuthProvider.signIn — lingering / revoked-session self-heal.
//
// signIn must clear a stale LOCAL session (a user still "signed in", or a token
// revoked out-of-band by a global sign-out in a sibling app on the same user
// pool) and retry once, so a returning user is never wedged at the login form.
// A genuine bad-credentials error must NOT trigger the clear-and-retry.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the aws-amplify/auth surface the provider imports. Only signIn + signOut
// matter here; the rest are inert stubs so the module loads.
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

import { signIn as amplifySignIn, signOut as amplifySignOut } from 'aws-amplify/auth';

import { CognitoAuthProvider } from './cognito';

const mockSignIn = vi.mocked(amplifySignIn);
const mockSignOut = vi.mocked(amplifySignOut);

/** An Error with a Cognito-style `name`, as Amplify throws. */
function named(name: string, message = name): Error {
  return Object.assign(new Error(message), { name });
}

const DONE = { isSignedIn: true, nextStep: { signInStep: 'DONE' } };
const CREDS = { email: 'Owner@Example.com', password: 'pw' };

function provider(): CognitoAuthProvider {
  return new CognitoAuthProvider({ developerApiBase: 'https://api.test', productName: 'Test' });
}

describe('CognitoAuthProvider.signIn — stale-session self-heal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('clears a lingering already-authenticated session and retries', async () => {
    mockSignIn
      .mockRejectedValueOnce(named('UserAlreadyAuthenticatedException', 'already a signed in user'))
      .mockResolvedValueOnce(DONE as never);
    mockSignOut.mockResolvedValue(undefined as never);

    await expect(provider().signIn(CREDS)).resolves.toEqual({ kind: 'COMPLETE' });
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockSignIn).toHaveBeenCalledTimes(2);
    // The retry reuses the (lowercased) credentials.
    expect(mockSignIn).toHaveBeenLastCalledWith({ username: 'owner@example.com', password: 'pw' });
  });

  it('clears a revoked-token session (NotAuthorized + "revoked") and retries', async () => {
    mockSignIn
      .mockRejectedValueOnce(named('NotAuthorizedException', 'Access Token has been revoked'))
      .mockResolvedValueOnce(DONE as never);
    mockSignOut.mockResolvedValue(undefined as never);

    await expect(provider().signIn(CREDS)).resolves.toEqual({ kind: 'COMPLETE' });
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockSignIn).toHaveBeenCalledTimes(2);
  });

  it('still recovers when the best-effort signOut itself fails', async () => {
    mockSignIn
      .mockRejectedValueOnce(named('NotAuthorizedException', 'Access Token has been revoked'))
      .mockResolvedValueOnce(DONE as never);
    // A revoked token can make the clearing signOut reject too — must be swallowed.
    mockSignOut.mockRejectedValue(named('NotAuthorizedException', 'Access Token has been revoked'));

    await expect(provider().signIn(CREDS)).resolves.toEqual({ kind: 'COMPLETE' });
    expect(mockSignIn).toHaveBeenCalledTimes(2);
  });

  it('does NOT clear/retry on bad credentials', async () => {
    mockSignIn.mockRejectedValue(named('NotAuthorizedException', 'Incorrect username or password.'));

    await expect(provider().signIn(CREDS)).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockSignIn).toHaveBeenCalledTimes(1);
  });
});
