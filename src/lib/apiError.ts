// ---------------------------------------------------------------------------
// API error helpers — pull the support-correlation id and message out of a
// failed SDK call.
//
// Every partner-API error body is always-valid JSON of the shape
// `{ "message": string, "requestId": string, ...}`. The SDK surfaces it as
// `VectrosError.body` (typed `unknown`). These helpers duck-type that body so
// a host app can show the `requestId`/message for support WITHOUT importing
// the SDK's error classes (keeping them trivially unit-testable and resilient
// to SDK refactors).
//
// Kept framework-free (no React, no SDK class import) and pure. Promoted
// here (2026-08-28) from three near-byte-identical per-app copies
// (`admin-app`, `app-vectros-ai`, `casework-spa`) — see this package's own
// `ApiErrorAlert`/`RequestIdCaption`, the components that consume these.
// ---------------------------------------------------------------------------

/** The HTTP status code of a failed SDK call, if the error carries one. */
export function statusCodeOf(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'statusCode' in err) {
    const code = (err as { statusCode?: unknown }).statusCode;
    if (typeof code === 'number') return code;
  }
  return undefined;
}

/**
 * True when a failed call returned HTTP 409 Conflict. Duck-typed via
 * {@link statusCodeOf} so it doesn't depend on importing the SDK's
 * `ConflictError` class.
 *
 * **On a record or document UPDATE this means an optimistic-concurrency
 * conflict** — the row changed since the `expectedVersion` you sent — and that
 * is the case this helper is for. Those paths raise no other 409 (immutable
 * identifiers are ignored on update), so a 409 there is unambiguous and
 * "someone else changed this; reload and try again" is the right thing to say.
 *
 * **It is a status-code test, not a cause test, and 409 is not reserved to
 * version conflicts across the rest of the API.** Other endpoints answer 409
 * for resource-state reasons: `DELETE /v1/schemas/{id}` while records of that
 * type still exist, `PUT /v1/schemas/{id}` when the update would turn off a
 * capability other declarations still depend on, `POST /v1/admin/keys/scoped`
 * against a suspended principal. Those are permanent for the request as sent —
 * reloading and retrying, the remedy a version-conflict UI offers, fails
 * identically every time and reads to the user as the app being stuck. (Not
 * every refusal of that shape is a 409: a non-empty folder refuses its own
 * delete with a `400`, so it never reaches this helper at all. Check the
 * endpoint you called rather than generalizing from the shape of the rule.)
 *
 * This helper does not try to tell them apart — it stays a status test, so it
 * keeps answering the same way for every caller that already relies on it. Use
 * it where you know the request was a versioned update. Where you do not, read
 * {@link errorCodeOf}: the envelope names the cause (`VERSION_CONFLICT` versus,
 * say, `RESOURCE_IN_USE`), and surfacing {@link extractErrorMessage} beats a
 * fixed "someone else changed this" string in either case.
 */
export function isVersionConflict(err: unknown): boolean {
  return statusCodeOf(err) === 409;
}

/**
 * Extract the machine-readable `errorCode` from a failed SDK call's error
 * envelope, if it carries one.
 *
 * The uniform error contract puts a stable, documented code on the failures
 * that a client might reasonably branch on, alongside the human-readable
 * `message` — so two responses sharing a status code can still be told apart.
 * The pair this exists for is the one a status test cannot resolve:
 * `VERSION_CONFLICT` (your update raced another writer — reload and retry) and
 * `RESOURCE_IN_USE` (the resource is still referenced by live dependents, so
 * retrying the same request never succeeds) both arrive as HTTP 409. Not every
 * 409 is one of the two — the suspended-principal refusal on
 * `POST /v1/admin/keys/scoped` carries no code at all — so a code-less 409 on a
 * versioned update is still best read through {@link isVersionConflict}.
 *
 * Not every error carries one — plenty of 4xx responses have only a `message` —
 * so treat `undefined` as "the API did not name a cause", never as "no error".
 * Match on the value and treat an unrecognised code as unknown rather than
 * assuming your list is exhaustive: the set grows with the API, and a client
 * that switches exhaustively on it will be wrong after a release it did not
 * read about.
 *
 * Returns undefined for a non-API error (network, abort) or a malformed body.
 */
export function errorCodeOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('body' in err)) return undefined;
  const body = (err as { body?: unknown }).body;
  if (typeof body !== 'object' || body === null || !('errorCode' in body)) return undefined;
  const errorCode = (body as { errorCode?: unknown }).errorCode;
  return typeof errorCode === 'string' && errorCode !== '' ? errorCode : undefined;
}

/**
 * Extract the `requestId` correlation id from a failed SDK call, if
 * present. Reads `err.body.requestId` (the always-valid JSON error envelope);
 * returns undefined for non-API errors (network, abort) or a malformed body so
 * callers can simply omit the reference line when there's nothing to show.
 */
export function extractRequestId(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('body' in err)) return undefined;
  const body = (err as { body?: unknown }).body;
  if (typeof body !== 'object' || body === null || !('requestId' in body)) return undefined;
  const requestId = (body as { requestId?: unknown }).requestId;
  return typeof requestId === 'string' && requestId !== '' ? requestId : undefined;
}

/**
 * Extract the human-readable `message` from a failed SDK call's error envelope,
 * if present. Reads `err.body.message` — the always-valid partner-API error JSON
 * whose `message` is a client-facing string (uniform error contract): e.g. a
 * `400` naming the out-of-range number field and how to fix it. Returns
 * undefined for a non-API error (network, abort) or a malformed / empty body so
 * callers fall back to their own generic copy.
 */
export function extractErrorMessage(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('body' in err)) return undefined;
  const body = (err as { body?: unknown }).body;
  if (typeof body !== 'object' || body === null || !('message' in body)) return undefined;
  const message = (body as { message?: unknown }).message;
  return typeof message === 'string' && message.trim() !== '' ? message.trim() : undefined;
}
