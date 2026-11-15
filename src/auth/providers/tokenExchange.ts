// ---------------------------------------------------------------------------
// The Vectros token-exchange call shared by the hosted sign-in providers.
//
// `POST /v1/auth/token/exchange` (RFC 8693) takes a token from the tenant's
// own identity provider and returns a short-lived Vectros `st_*` bearer. The
// providers differ only in how they obtain the subject token; the request,
// the one bounded race retry and the error mapping are the same, so they live
// here once.
// ---------------------------------------------------------------------------

import { AuthError } from '../errors';
import type { PartnerApiResolvedScope } from '../vectrosApiTokenCache';
import { parseResolvedScope } from '../vectrosApiTokenCache';

/** Wire shape of `POST /v1/auth/token/exchange`'s success response (RFC 8693 §2.2.1). */
interface ExchangeSuccessResponse {
  readonly access_token: string;
  readonly expires_in: number;
  /**
   * camelCase: a Vectros-specific extension to the RFC 8693 envelope, not
   * part of the RFC, so not snake_case like the fields above. The token's
   * resolved `allowedActions`/`identity`, parsed via {@link parseResolvedScope}.
   */
  readonly resolvedScope?: unknown;
}

/** Wire shape of the exchange endpoint's OAuth-standard error envelope (RFC 6749 §5.2). */
interface ExchangeErrorResponse {
  readonly error?: string;
  readonly error_description?: string;
}

/** Options a caller can forward on one exchange. See {@link exchangeSubjectToken}. */
export interface TokenExchangeOptions {
  readonly inviteToken?: string;
  readonly signupType?: string;
  readonly contextId?: string;
  readonly skipOwnRetry?: boolean;
}

/** A minted Vectros bearer, its expiry (epoch ms) and its resolved scope. */
export interface ExchangedToken {
  readonly token: string;
  readonly expiresAtMs: number;
  readonly resolvedScope: PartnerApiResolvedScope;
}

/**
 * How long to wait before the one-shot self-signup-race retry below. Short
 * enough not to be a noticeable UI stall; long enough to clear a same-second
 * concurrent write on the other side of the race.
 */
export const EXCHANGE_RACE_RETRY_DELAY_MS = 400;

/** How long one exchange request may take before it is abandoned as a network failure. */
export const EXCHANGE_TIMEOUT_MS = 30_000;

/**
 * Throws unless `endpoint` is an https URL, or http to the loopback host
 * (for local development only). The exchange sends the user's identity token,
 * so it must never travel in clear text.
 */
export function assertExchangeEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`The token exchange endpoint is not a URL: ${endpoint}`);
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`The token exchange endpoint must use https: ${endpoint}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reads a `Retry-After` header (RFC 9110 §10.2.3): either a number of seconds
 * or an HTTP date. Returns whole seconds, at least 0, or undefined when the
 * header is absent or unreadable.
 */
export function parseRetryAfterSeconds(value: string | null, nowMs: number = Date.now()): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) ? seconds : undefined;
  }
  // Only the IMF-fixdate form (`Sun, 06 Nov 1994 08:49:37 GMT`): Date.parse
  // alone also accepts strings such as "1.5" as a date.
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(trimmed)) return undefined;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - nowMs) / 1000));
}

/**
 * Exchanges `subjectToken` at `endpoint` for a Vectros bearer.
 *
 * The token is sent under the generic `...token-type:jwt` label. Its `iss`
 * and `aud` must match an issuer registration on the target app context.
 *
 * **One bounded retry on a 403, except when `inviteToken` is set or
 * `skipOwnRetry` is.** The endpoint returns the same generic `403
 * invalid_grant` for several distinct rejections and discloses no cause. One
 * of them is transient: two near-simultaneous first exchanges for the same
 * brand-new identity race each other, and the loser gets a 403 although an
 * immediate retry would succeed. Every other cause fails again identically,
 * so the retry costs one extra request in those cases. An invite exchange
 * never takes the self-signup path the race lives in, so it is not retried.
 * The token cache retries the same race itself, coalescing every caller onto
 * one attempt, so a minter called by the cache passes `skipOwnRetry` to keep
 * the two retries from stacking.
 *
 * Throws `AuthError('NETWORK_ERROR')` when the request cannot be sent or takes
 * longer than {@link EXCHANGE_TIMEOUT_MS}; `AuthError('LIMIT_EXCEEDED')` on a
 * `429`, carrying the server's `Retry-After` as `retryAfterSeconds` (a `429` is
 * never retried here: the server has said when to come back); and `AuthError('UNKNOWN')` carrying
 * the status and OAuth error code for a refusal, or naming the problem when a
 * success response is not a usable token.
 * An issuer registration still pending verification answers `404`, the same
 * as an unknown issuer.
 */
export async function exchangeSubjectToken(
  endpoint: string,
  subjectToken: string,
  options?: TokenExchangeOptions,
): Promise<ExchangedToken> {
  const attempt = async (): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXCHANGE_TIMEOUT_MS);
    try {
      return await fetch(endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
          subject_token: subjectToken,
          subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
          ...(options?.inviteToken ? { invite_token: options.inviteToken } : {}),
          ...(options?.signupType ? { signup_type: options.signupType } : {}),
          ...(options?.contextId ? { context_id: options.contextId } : {}),
        }),
      });
    } catch (e) {
      if (controller.signal.aborted) {
        throw new AuthError('NETWORK_ERROR', 'Token exchange request timed out.');
      }
      throw new AuthError('NETWORK_ERROR', e instanceof Error ? e.message : 'Token exchange request failed.');
    } finally {
      clearTimeout(timer);
    }
  };

  let resp = await attempt();
  if (resp.status === 403 && !options?.inviteToken && !options?.skipOwnRetry) {
    await delay(EXCHANGE_RACE_RETRY_DELAY_MS);
    resp = await attempt();
  }

  if (resp.status === 429) {
    const retryAfterSeconds = parseRetryAfterSeconds(resp.headers.get('Retry-After'));
    throw new AuthError(
      'LIMIT_EXCEEDED',
      retryAfterSeconds === undefined
        ? 'Token exchange is rate limited.'
        : `Token exchange is rate limited; retry after ${retryAfterSeconds} s.`,
      retryAfterSeconds,
    );
  }
  if (!resp.ok) {
    const body = (await resp.json().catch(() => null)) as ExchangeErrorResponse | null;
    // The server keeps 401/403/404 bodies generic on purpose: surface the
    // status and OAuth `error` code as diagnostics, never a finer
    // distinction than the server itself makes.
    throw new AuthError(
      'UNKNOWN',
      `Token exchange failed: ${resp.status} ${body?.error ?? ''} ${body?.error_description ?? ''}`.trim(),
    );
  }
  const data = (await resp.json().catch(() => null)) as Partial<ExchangeSuccessResponse> | null;
  if (!data || typeof data.access_token !== 'string' || data.access_token === '') {
    throw new AuthError('UNKNOWN', `Token exchange returned ${resp.status} without a token.`);
  }
  // A missing or non-positive lifetime would make the cache re-mint on every
  // call; refuse it rather than storm the endpoint.
  if (typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
    throw new AuthError('UNKNOWN', `Token exchange returned ${resp.status} without a valid expires_in.`);
  }
  return {
    token: data.access_token,
    expiresAtMs: Date.now() + data.expires_in * 1000,
    resolvedScope: parseResolvedScope(data.resolvedScope),
  };
}
