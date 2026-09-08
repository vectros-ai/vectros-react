// ---------------------------------------------------------------------------
// apiError tests — duck-typing the error envelope without importing
// the SDK's error classes. Covers the present/absent/malformed branches that
// decide whether the UI shows a support reference line.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import {
  errorCodeOf,
  extractErrorMessage,
  extractRequestId,
  isVersionConflict,
  statusCodeOf,
} from './apiError';

describe('extractRequestId', () => {
  it('reads requestId from a well-formed error envelope', () => {
    const err = { statusCode: 500, body: { message: 'Internal error', requestId: 'corr-abc-123' } };
    expect(extractRequestId(err)).toBe('corr-abc-123');
  });

  it('returns undefined when the body has no requestId', () => {
    expect(extractRequestId({ statusCode: 400, body: { message: 'Bad request' } })).toBeUndefined();
  });

  it('returns undefined for an empty-string requestId', () => {
    expect(extractRequestId({ body: { requestId: '' } })).toBeUndefined();
  });

  it('returns undefined for a non-string requestId', () => {
    expect(extractRequestId({ body: { requestId: 42 } })).toBeUndefined();
  });

  it('returns undefined when there is no body (network/abort error)', () => {
    expect(extractRequestId(new Error('Network down'))).toBeUndefined();
  });

  it('returns undefined for null / non-object / undefined', () => {
    expect(extractRequestId(null)).toBeUndefined();
    expect(extractRequestId(undefined)).toBeUndefined();
    expect(extractRequestId('boom')).toBeUndefined();
    expect(extractRequestId({ body: null })).toBeUndefined();
  });
});

describe('extractErrorMessage', () => {
  it('reads the client-facing message from a well-formed error envelope', () => {
    const err = {
      statusCode: 400,
      body: { message: "Field 'count' is outside the signed 64-bit range.", requestId: 'r-1' },
    };
    expect(extractErrorMessage(err)).toBe("Field 'count' is outside the signed 64-bit range.");
  });

  it('trims surrounding whitespace', () => {
    expect(extractErrorMessage({ body: { message: '  spaced  ' } })).toBe('spaced');
  });

  it('returns undefined for a whitespace-only or empty message', () => {
    expect(extractErrorMessage({ body: { message: '   ' } })).toBeUndefined();
    expect(extractErrorMessage({ body: { message: '' } })).toBeUndefined();
  });

  it('returns undefined when the body has no message', () => {
    expect(extractErrorMessage({ body: { requestId: 'r-1' } })).toBeUndefined();
  });

  it('returns undefined for a non-string message', () => {
    expect(extractErrorMessage({ body: { message: 42 } })).toBeUndefined();
  });

  it('returns undefined for a non-API error (network/abort) or null/undefined', () => {
    expect(extractErrorMessage(new Error('Network down'))).toBeUndefined();
    expect(extractErrorMessage(null)).toBeUndefined();
    expect(extractErrorMessage(undefined)).toBeUndefined();
    expect(extractErrorMessage({ body: null })).toBeUndefined();
  });
});

describe('statusCodeOf', () => {
  it('reads a numeric statusCode', () => {
    expect(statusCodeOf({ statusCode: 409 })).toBe(409);
  });

  it('returns undefined when absent or non-numeric', () => {
    expect(statusCodeOf({})).toBeUndefined();
    expect(statusCodeOf({ statusCode: '409' })).toBeUndefined();
    expect(statusCodeOf(null)).toBeUndefined();
  });
});

describe('isVersionConflict', () => {
  it('is true only for a 409', () => {
    expect(isVersionConflict({ statusCode: 409 })).toBe(true);
    expect(isVersionConflict({ statusCode: 400 })).toBe(false);
    expect(isVersionConflict({})).toBe(false);
  });
});

describe('errorCodeOf', () => {
  it('reads the envelope’s machine-readable cause', () => {
    expect(errorCodeOf({ statusCode: 409, body: { errorCode: 'VERSION_CONFLICT' } }))
      .toBe('VERSION_CONFLICT');
  });

  it('separates two failures that share a status code', () => {
    // The pair the status test cannot resolve: one is worth offering a reload
    // and retry for, the other will refuse the identical request forever.
    const raced = { statusCode: 409, body: { errorCode: 'VERSION_CONFLICT' } };
    const stillReferenced = { statusCode: 409, body: { errorCode: 'RESOURCE_IN_USE' } };
    expect(isVersionConflict(raced)).toBe(true);
    expect(isVersionConflict(stillReferenced)).toBe(true); // a status test cannot tell
    expect(errorCodeOf(raced)).not.toBe(errorCodeOf(stillReferenced)); // this can
  });

  it('is undefined when the API named no cause — not an assertion that there was none', () => {
    expect(errorCodeOf({ statusCode: 409, body: { message: 'Duplicate ID specified' } }))
      .toBeUndefined();
    expect(errorCodeOf({ statusCode: 500 })).toBeUndefined();
  });

  it('returns undefined for a non-API error or a malformed body', () => {
    expect(errorCodeOf(new Error('network'))).toBeUndefined();
    expect(errorCodeOf({ body: 'not an object' })).toBeUndefined();
    expect(errorCodeOf({ body: null })).toBeUndefined();
    expect(errorCodeOf({ body: { errorCode: 42 } })).toBeUndefined();
    expect(errorCodeOf({ body: { errorCode: '' } })).toBeUndefined();
    expect(errorCodeOf(null)).toBeUndefined();
  });
});
