// ---------------------------------------------------------------------------
// createPublicClient — anonymous reads of an app context's public records, with a publishable app key.
//
// A publishable key (`pub_...`) is meant to ship in web pages and mobile apps: it reads only the public views of
// one app context and grants nothing else. This client binds that key once and exposes the three public reads
// (get, list by a lookup field, search) over the SDK's generated `public` sub-client, which sends no
// Authorization header.
//
// It refuses what does not belong on a public client:
//   - any credential that is not a publishable key (an `sk_`, `ssk_` or `st_` credential must never reach a page);
//   - a server key (`pubs_...`) without its server secret, a server key inside a browser page, a Web Worker or a
//     React Native app, and a server key whose baseUrl is not https: (plain http: only to localhost).
//
// Failed reads throw the SDK's errors unchanged; read them with `statusCodeOf` and `errorCodeOf` from this
// package (a 404 is the uniform "no such public record", a 429 carries Retry-After, a 503 carries an errorCode
// such as PUBLIC_ACCESS_NOT_ENABLED or the budget's).
// ---------------------------------------------------------------------------

import { VectrosClient, type Vectros } from '@vectros-ai/sdk';

/** The production API. Pass `baseUrl` for another environment. */
export const DEFAULT_PUBLIC_BASE_URL = 'https://api.vectros.ai';

/** The header a server key's secret travels in. */
export const PUBLIC_SERVER_SECRET_HEADER = 'X-Vectros-Public-Server-Secret';

export interface PublicClientOptions {
  /** A publishable app key: `pub_...` (browser) or `pubs_...` (server, with `serverSecret`). */
  key: string;
  /** The API base URL. Defaults to {@link DEFAULT_PUBLIC_BASE_URL}. */
  baseUrl?: string;
  /** A server key's secret, returned when the key was issued, and again to a retry that repeats the same `Idempotency-Key`. Server-side code only. */
  serverSecret?: string;
  /** A fetch implementation, for runtimes without a global one. */
  fetch?: typeof fetch;
  /** Retries on a 429 or 5xx answer (the SDK's default when omitted). */
  maxRetries?: number;
  /** Per-request timeout in seconds (the SDK's default when omitted). */
  timeoutInSeconds?: number;
}

/** One public record: only the fields its type publishes. */
export interface PublicRecord {
  publicId: string;
  type: string;
  fields: Record<string, unknown>;
  publishedAt?: string;
  /** For a type that publishes a location at a coarser precision: each location field's precision. */
  geoPrecision?: Record<string, unknown>;
  /** On a search near a place: the distance from the place, in metres. */
  distanceMeters?: number;
}

export interface PublicRecordPage {
  data: PublicRecord[];
  /** Pass as `cursor` for the next page; null on the last. A page can be shorter than `limit` while this is set. */
  nextCursor: string | null;
}

export interface PublicSearchPage {
  data: PublicRecord[];
  hasMore: boolean;
  incompleteResults?: boolean;
}

export interface PublicListOptions {
  /** Exactly one lookup field the type publishes, and the value to list by, for example `{ city: 'Lisbon' }`. */
  by: Record<string, string | number | boolean>;
  /** Page size, 1 to 40 (the API's default is 20). */
  limit?: number;
  /** The `nextCursor` of the previous page. */
  cursor?: string;
}

export interface PublicNear {
  lat: number | string;
  lon: number | string;
  /** Whole metres, 1 to 200000. */
  radius: number;
}

/**
 * A range filter on a filterable `number`, `date` or `instant` field, sent as `filter.<field>.from` and `filter.<field>.to` (both inclusive; either
 * alone is open on the other side; a range with neither throws a `RangeError` rather than search unfiltered). A number bound is a plain
 * decimal in its shortest form, at most 15 digits before and 15 after the point: a `number` that would print otherwise (`1e21`,
 * `0.1 + 0.2`) throws a `RangeError`, so round it first. A date bound is a calendar day, `YYYY-MM-DD`, in UTC (`to` includes the whole
 * day). An `instant` bound is a moment in UTC to the millisecond, `YYYY-MM-DDTHH:MM:SS.sssZ`; both bounds are inclusive, so a whole day
 * runs from its first millisecond to its last, `T23:59:59.999Z`. In JavaScript, `new Date().toISOString()` gives a moment in this spelling,
 * and `new Date('2026-11-20T00:00:00.000Z').toISOString()` is the first moment of 20 November UTC; the last is `2026-11-20T23:59:59.999Z`.
 * If the type sets `publicView.cacheSeconds` above 0, the edge cache keeps the answer to an identical search for up to that long. A page
 * flagged `incompleteResults` that has no results, or that a search limit cut short, is not cached. A bound that changes on every request,
 * such as the current millisecond, makes every search different, so it never hits the cache. Round such a bound, for example to the start
 * of the hour.
 */
export interface PublicRange {
  from?: string | number;
  to?: string | number;
}

/**
 * A set filter on a filterable `string`, `enum`, `number` or `instant` field, sent as `filter.<field>.in=a,b`: a result matches any value in the set.
 * 1 to 10 values; the client sorts them and drops duplicates (the server takes one spelling only): by value when every value is a plain
 * decimal in its shortest form (no leading or trailing zero, no plus sign, no `-0`), otherwise in character-code order. A value cannot be empty or contain a comma; a number value follows the same rule as a
 * {@link PublicRange} bound. Either rule broken throws a `RangeError` before any request.
 */
export interface PublicSet {
  in: ReadonlyArray<string> | ReadonlyArray<number>;
}

export interface PublicSearchOptions {
  /**
   * The text to search for, at most 256 characters. It is optional with `near`, with `sortBy` or with at least one filter. With `near`,
   * results come nearest first. With `sortBy`, they come in that field's order. With a filter, they come in a fixed order, the same on
   * every page, while at most 2,000 index entries match and no search limit stops the search. A blank `q` is not sent.
   */
  q?: string;
  /** `text`, `semantic` or `hybrid`: one the type offers. With `sortBy` it is `text`. */
  mode?: 'text' | 'semantic' | 'hybrid';
  near?: PublicNear;
  /**
   * Filters on fields the type marks filterable: a value is sent as `filter.<field>` (at most 128 characters); a {@link PublicRange} on a
   * `number`, `date` or `instant` field as `filter.<field>.from` and `filter.<field>.to`; a {@link PublicSet} as `filter.<field>.in` (at most three
   * range or set fields per search).
   */
  filters?: Record<string, string | number | boolean | PublicRange | PublicSet>;
  /**
   * The id of a filterable `number`, `date` or `instant` field the type publishes; results come in that field's order, records without a
   * value last. At most 2,000 matches are put in order. If more match, or a search limit stops the search, the page carries
   * `incompleteResults: true`.
   */
  sortBy?: string;
  /** `'asc'` (the default) or `'desc'`. Needs `sortBy`. */
  order?: 'asc' | 'desc';
  /** How many results to skip, 0 to 200. */
  offset?: number;
  /** Page size, 1 to 40. */
  limit?: number;
}

/** Per-call options. */
export interface PublicRequestOptions {
  abortSignal?: AbortSignal;
}

export interface PublicClient {
  /** Which app context and API this client reads: part of every cache key the hooks use. */
  readonly id: string;
  /** One public record by its public id. A missing, unpublished or foreign record is the same 404. */
  get(type: string, publicId: string, options?: PublicRequestOptions): Promise<PublicRecord>;
  /** One page of a type's public records, listed by one published lookup field. */
  list(type: string, options: PublicListOptions, requestOptions?: PublicRequestOptions): Promise<PublicRecordPage>;
  /** Every public record matching `options.by`, page after page, until the last. */
  listAll(type: string, options: Omit<PublicListOptions, 'cursor'>, requestOptions?: PublicRequestOptions): AsyncIterable<PublicRecord>;
  /** A search of a type's public records (the modes the type offers), optionally near a place, with filters, or ordered by a field. */
  search(type: string, options: PublicSearchOptions, requestOptions?: PublicRequestOptions): Promise<PublicSearchPage>;
}

const NOT_PUBLISHABLE = /^(sk|ssk|st)_/;

/** True in code that ships to visitors: a browser page, a Web Worker, or a React Native app. */
function isClientRuntime(): boolean {
  const g = globalThis as { window?: unknown; document?: unknown; navigator?: { product?: string }; importScripts?: unknown };
  if (typeof g.window !== 'undefined' && typeof g.document !== 'undefined') return true;
  if (g.navigator?.product === 'ReactNative') return true;
  return typeof g.importScripts === 'function';
}

/** A coordinate as the API wants it: a plain decimal with at most 6 decimal places, never exponent notation. */
export function formatCoordinate(value: number | string): string {
  if (typeof value === 'string') {
    if (!/^-?\d+(\.\d{1,6})?$/.test(value)) throw new RangeError('A coordinate string is a plain decimal with at most 6 decimal places.');
    return value;
  }
  if (!Number.isFinite(value)) throw new RangeError('A coordinate must be a finite number.');
  const fixed = value.toFixed(6).replace(/\.?0+$/, '');
  return fixed === '-0' ? '0' : fixed;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A server secret travels only over https; plain http only to this machine (local development). */
function assertSecretTransport(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError(`baseUrl is not a URL: ${baseUrl}`);
  }
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return;
  throw new TypeError('A server key sends its secret only to an https: baseUrl (plain http: only to localhost).');
}

function toRecord(r: Vectros.PublicRecordResponse): PublicRecord {
  return {
    publicId: r.publicId ?? '',
    type: r.type ?? '',
    fields: (r.fields ?? {}) as Record<string, unknown>,
    ...(r.publishedAt !== undefined ? { publishedAt: r.publishedAt } : {}),
    ...(r.geoPrecision !== undefined ? { geoPrecision: r.geoPrecision } : {}),
    ...(r.distanceMeters !== undefined ? { distanceMeters: r.distanceMeters } : {}),
  };
}

/**
 * Create a client for anonymous public reads, bound to one publishable key.
 *
 * ```ts
 * const pub = createPublicClient({ key: 'pub_...' });
 * const event = await pub.get('event', publicId);
 * const page = await pub.list('event', { by: { city: 'Lisbon' }, limit: 20 });
 * const near = await pub.search('event', { near: { lat: 38.72, lon: -9.14, radius: 2000 } });
 * ```
 */
export function createPublicClient(options: PublicClientOptions): PublicClient {
  const { key } = options;
  if (typeof key !== 'string' || key.length === 0) throw new TypeError('createPublicClient needs a publishable key (pub_... or pubs_...).');
  if (NOT_PUBLISHABLE.test(key)) {
    throw new TypeError(
      'createPublicClient takes a publishable key (pub_... or pubs_...), never an API key or token: those grant access to ' +
        'private data and must not be shipped to a page or an app.',
    );
  }
  const serverKey = key.startsWith('pubs_');
  if (!serverKey && !key.startsWith('pub_')) throw new TypeError('createPublicClient needs a publishable key (pub_... or pubs_...).');
  if (serverKey && !options.serverSecret) {
    throw new TypeError('A server key (pubs_...) needs its serverSecret; for a web page or an app, issue a browser key (pub_...).');
  }
  if (!serverKey && options.serverSecret) throw new TypeError('serverSecret belongs to a server key (pubs_...), not a browser key.');
  if (serverKey && isClientRuntime()) {
    throw new TypeError('A server key and its secret must stay on your server; in a web page or an app, use a browser key (pub_...).');
  }
  const baseUrl = (options.baseUrl ?? DEFAULT_PUBLIC_BASE_URL).replace(/\/+$/, '');
  if (serverKey) assertSecretTransport(baseUrl);

  const sdk = new VectrosClient({
    environment: baseUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    ...(options.timeoutInSeconds !== undefined ? { timeoutInSeconds: options.timeoutInSeconds } : {}),
    ...(options.serverSecret ? { headers: { [PUBLIC_SERVER_SECRET_HEADER]: options.serverSecret } } : {}),
  });
  const reads = (sdk as { public?: VectrosClient['public'] }).public;
  if (!reads) throw new Error('createPublicClient needs @vectros-ai/sdk 0.50.0 or later (the anonymous public reads).');

  const list: PublicClient['list'] = async (type, listOptions, requestOptions) => {
    const entries = Object.entries(listOptions.by ?? {});
    if (entries.length !== 1) throw new TypeError('list takes exactly one lookup field in `by`, for example { city: "Lisbon" }.');
    const [field, value] = entries[0] as [string, string | number | boolean];
    if (field === 'k' || field === 'limit' || field === 'cursor') throw new TypeError(`'${field}' cannot be a list field.`);
    const page = await reads.listPublicRecords(
      { type, k: key, ...(listOptions.limit !== undefined ? { limit: listOptions.limit } : {}), ...(listOptions.cursor ? { cursor: listOptions.cursor } : {}) },
      { queryParams: { [field]: String(value) }, ...(requestOptions?.abortSignal ? { abortSignal: requestOptions.abortSignal } : {}) },
    );
    return { data: (page.data ?? []).map(toRecord), nextCursor: page.nextCursor ?? null };
  };

  return {
    id: `${baseUrl}|${key}`,
    async get(type, publicId, requestOptions) {
      const r = await reads.getPublicRecord(
        { type, publicId, k: key },
        requestOptions?.abortSignal ? { abortSignal: requestOptions.abortSignal } : undefined,
      );
      return toRecord(r);
    },
    list,
    async *listAll(type, listOptions, requestOptions) {
      let cursor: string | undefined;
      for (;;) {
        const page = await list(type, { ...listOptions, ...(cursor ? { cursor } : {}) }, requestOptions);
        yield* page.data;
        if (!page.nextCursor) return;
        cursor = page.nextCursor;
      }
    },
    async search(type, searchOptions, requestOptions) {
      const near = searchOptions.near;
      const page = await reads.searchPublicRecords(
        {
          type,
          k: key,
          // a blank q is not sent: with filters it is a filter-only search, and the server refuses a q that is sent but empty
          ...(searchOptions.q !== undefined && searchOptions.q.trim() !== '' ? { q: searchOptions.q } : {}),
          ...(searchOptions.mode !== undefined ? { mode: searchOptions.mode } : {}),
          ...(searchOptions.offset !== undefined ? { offset: searchOptions.offset } : {}),
          ...(searchOptions.limit !== undefined ? { limit: searchOptions.limit } : {}),
          ...(near
            ? { 'near.lat': formatCoordinate(near.lat), 'near.lon': formatCoordinate(near.lon), 'near.radius': near.radius }
            : {}),
        },
        {
          ...(requestOptions?.abortSignal ? { abortSignal: requestOptions.abortSignal } : {}),
          // `sortBy` and `order` ride the raw query parameters, as the filters do: the generated request type of an older SDK does not name them
          ...(searchOptions.filters || searchOptions.sortBy !== undefined || searchOptions.order !== undefined
            ? {
                queryParams: {
                  ...(searchOptions.filters
                    ? Object.fromEntries(Object.entries(searchOptions.filters).flatMap(([f, v]) => filterParams(f, v)))
                    : {}),
                  ...(searchOptions.sortBy !== undefined ? { sortBy: searchOptions.sortBy } : {}),
                  ...(searchOptions.order !== undefined ? { order: searchOptions.order } : {}),
                },
              }
            : {}),
        },
      );
      return { data: (page.data ?? []).map(toRecord), hasMore: page.hasMore ?? false, ...(page.incompleteResults !== undefined ? { incompleteResults: page.incompleteResults } : {}) };
    },
  };
}

const RANGE_NUMBER = /^-?(0|[1-9]\d{0,14})(\.\d{0,14}[1-9])?$/;

/** A range bound as sent: a string as given (the server checks it); a number only when it prints as the plain decimal the server takes. */
function rangeBound(field: string, v: string | number): string {
  if (typeof v === 'string') return v;
  const s = String(v);
  if (!Number.isFinite(v) || !RANGE_NUMBER.test(s)) {
    throw new RangeError(`The range bound ${s} of ${field} does not print as a plain decimal with at most 15 digits on each side of the point; round it first.`);
  }
  return s;
}

/**
 * A set's one spelling: unique values in ascending order. The order reads the values, as the server does: by value when every value is a
 * plain decimal (so `[9, 10]` on a field of codes is `9,10`), otherwise in UTF-16 code-unit order (the server's `String.compareTo`).
 */
function setParam(field: string, values: ReadonlyArray<string> | ReadonlyArray<number>): string {
  const list = Array.from(values as ReadonlyArray<string | number>).map((v) => {
    if (typeof v === 'number') {
      const s = String(v);
      if (!Number.isFinite(v) || !RANGE_NUMBER.test(s)) {
        throw new RangeError(`The set value ${s} of ${field} does not print as a plain decimal with at most 15 digits on each side of the point; round it first.`);
      }
      return s;
    }
    return v;
  });
  const unique = Array.from(new Set(list));
  if (unique.length === 0 || unique.length > 10) throw new RangeError(`The set on ${field} holds 1 to 10 values.`);
  for (const s of unique) {
    if (s === '' || s.includes(',') || s.length > 128 || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)) {
      throw new RangeError(`A value in the set on ${field} is empty, longer than 128 characters, holds a comma or a lone surrogate.`);
    }
  }
  const byValue = unique.every((s) => RANGE_NUMBER.test(s) && s !== '-0');
  return (byValue ? unique.sort(compareDecimal) : unique.sort()).join(',');
}

/**
 * Two shortest plain decimals compared exactly, as the server's BigDecimal does: a double holds fewer digits than the 15 + 15 allowed,
 * so `Number()` would call `100000000000000.001` and `100000000000000.002` equal.
 */
function compareDecimal(a: string, b: string): number {
  const negA = a.startsWith('-');
  const negB = b.startsWith('-');
  if (negA !== negB) return negA ? -1 : 1;
  const [ai = '', af = ''] = (negA ? a.slice(1) : a).split('.');
  const [bi = '', bf = ''] = (negB ? b.slice(1) : b).split('.');
  let c = ai.length !== bi.length ? ai.length - bi.length : ai < bi ? -1 : ai > bi ? 1 : 0;
  if (c === 0) {
    const width = Math.max(af.length, bf.length);
    const x = af.padEnd(width, '0');
    const y = bf.padEnd(width, '0');
    c = x < y ? -1 : x > y ? 1 : 0;
  }
  return negA ? -c : c;
}

/** One filter as its query parameters: a value is `filter.<field>`; a range is `filter.<field>.from` and/or `filter.<field>.to`. */
function filterParams(field: string, value: string | number | boolean | PublicRange | PublicSet): Array<[string, string]> {
  if (typeof value === 'object' && value !== null && 'in' in value) return [[`filter.${field}.in`, setParam(field, value.in)]];
  if (typeof value === 'object' && value !== null) {
    const out: Array<[string, string]> = [];
    if (value.from != null) out.push([`filter.${field}.from`, rangeBound(field, value.from)]);
    if (value.to != null) out.push([`filter.${field}.to`, rangeBound(field, value.to)]);
    if (out.length === 0) throw new RangeError(`The range on ${field} has neither from nor to.`);
    return out;
  }
  return [[`filter.${field}`, String(value)]];
}
