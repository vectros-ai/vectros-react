// ---------------------------------------------------------------------------
// assertEmbeddedAuth / assertHostedAuth tests.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest';

import { assertEmbeddedAuth, assertHostedAuth } from './assertFacet';
import type { AuthContextValue } from './context';

const CORE: AuthContextValue = {
  user: null,
  loading: false,
  isAuthenticated: false,
  signOut: vi.fn(),
  getIdToken: vi.fn(),
};

describe('assertEmbeddedAuth', () => {
  it('does not throw when signIn is present', () => {
    const value: AuthContextValue = { ...CORE, signIn: vi.fn() };
    expect(() => assertEmbeddedAuth(value)).not.toThrow();
  });

  it('throws a clear error when signIn is absent (e.g. a hosted-redirect provider)', () => {
    const value: AuthContextValue = { ...CORE, signInWithRedirect: vi.fn() };
    expect(() => assertEmbeddedAuth(value)).toThrow(/does not implement EmbeddedCredentialAuth/);
  });
});

describe('assertHostedAuth', () => {
  it('does not throw when signInWithRedirect is present', () => {
    const value: AuthContextValue = { ...CORE, signInWithRedirect: vi.fn() };
    expect(() => assertHostedAuth(value)).not.toThrow();
  });

  it('throws a clear error when signInWithRedirect is absent (e.g. an embedded provider)', () => {
    const value: AuthContextValue = { ...CORE, signIn: vi.fn() };
    expect(() => assertHostedAuth(value)).toThrow(/does not implement HostedRedirectAuth/);
  });
});
