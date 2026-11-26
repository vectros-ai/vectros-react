// ---------------------------------------------------------------------------
// createPublicClient tests — the real SDK client over a recording fetch: what goes on the wire (the key as `k`,
// no Authorization header, the list field as a query parameter, near.* as plain decimals, the server secret header),
// the refusals of credentials that do not belong on a public client, paging, and error pass-through.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { createPublicClient, formatCoordinate, PUBLIC_SERVER_SECRET_HEADER, type PublicRange, type PublicSet } from './publicClient';
import { errorCodeOf, statusCodeOf } from '../lib/apiError';
import setOrderVectors from './set-order-vectors.json';

interface Call { url: URL; headers: Record<string, string> }

function recorder(answers: Array<{ status?: number; body: unknown }>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k.toLowerCase()] = v; });
    calls.push({ url: new URL(String(input instanceof Request ? input.url : input)), headers });
    const a = answers[Math.min(i++, answers.length - 1)] as { status?: number; body: unknown };
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: f, calls };
}

/** Run `fn` as on a server: no `window` or `document` (the test environment is a browser one). */
async function onServer<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as Record<string, unknown>;
  const saved = { window: Object.getOwnPropertyDescriptor(g, 'window'), document: Object.getOwnPropertyDescriptor(g, 'document') };
  Object.defineProperty(g, 'window', { value: undefined, configurable: true, writable: true });
  Object.defineProperty(g, 'document', { value: undefined, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    for (const [k, d] of Object.entries(saved)) if (d) Object.defineProperty(g, k, d);
  }
}

const REC = { publicId: 'p1', type: 'event', fields: { title: 'Beach cleanup' }, publishedAt: '2026-11-14T00:00:00Z' };

describe('createPublicClient: refusals', () => {
  it('refuses an API key or token, naming why', () => {
    for (const key of ['sk_live_abc', 'ssk_test_abc', 'st_abc']) {
      expect(() => createPublicClient({ key })).toThrow(/never an API key or token/);
    }
  });
  it('refuses an empty or unknown key, a server key without its secret, and a secret on a browser key', () => {
    expect(() => createPublicClient({ key: '' })).toThrow(/publishable key/);
    expect(() => createPublicClient({ key: 'abc' })).toThrow(/publishable key/);
    expect(() => createPublicClient({ key: 'pubs_abc' })).toThrow(/needs its serverSecret|must stay on your server/);
    expect(() => createPublicClient({ key: 'pub_abc', serverSecret: 's' })).toThrow(/belongs to a server key/);
  });
  it('refuses a server key in a React Native app and in a Web Worker', async () => {
    await onServer(async () => {
      const g = globalThis as Record<string, unknown>;
      const nav = Object.getOwnPropertyDescriptor(g, 'navigator');
      Object.defineProperty(g, 'navigator', { value: { product: 'ReactNative' }, configurable: true, writable: true });
      try {
        expect(() => createPublicClient({ key: 'pubs_abc', serverSecret: 's' })).toThrow(/web page or an app/);
      } finally {
        if (nav) Object.defineProperty(g, 'navigator', nav);
      }
      g.importScripts = () => undefined;
      try {
        expect(() => createPublicClient({ key: 'pubs_abc', serverSecret: 's' })).toThrow(/web page or an app/);
      } finally {
        delete g.importScripts;
      }
    });
  });

  it('refuses a server key inside a browser page (this test environment is one), and accepts it on a server', async () => {
    expect(() => createPublicClient({ key: 'pubs_abc', serverSecret: 's' })).toThrow(/must stay on your server/);
    await onServer(async () => {
      expect(() => createPublicClient({ key: 'pubs_abc', serverSecret: 's' })).not.toThrow();
      expect(() => createPublicClient({ key: 'pubs_abc' })).toThrow(/needs its serverSecret/);
    });
  });

  it('sends a server secret only to an https: baseUrl, or plain http: on this machine', async () => {
    await onServer(async () => {
      const make = (baseUrl: string) => () => createPublicClient({ key: 'pubs_abc', serverSecret: 's', baseUrl });
      expect(make('https://api.example.test')).not.toThrow();
      expect(make('http://localhost:8080')).not.toThrow();
      expect(make('http://127.0.0.1:3000/')).not.toThrow();
      expect(make('http://[::1]:3000')).not.toThrow();
      expect(make('http://api.example.test')).toThrow(/only to an https: baseUrl/);
      expect(make('http://localhost.example.test')).toThrow(/only to an https: baseUrl/);
      expect(make('ftp://api.example.test')).toThrow(/only to an https: baseUrl/);
      expect(make('not a url')).toThrow(/not a URL/);
    });
    // a browser key carries no secret, so any baseUrl is its owner's choice
    expect(() => createPublicClient({ key: 'pub_abc', baseUrl: 'http://api.example.test' })).not.toThrow();
  });
});

describe('createPublicClient: the reads', () => {
  it('get sends the key as k, no Authorization header, to the default production API', async () => {
    const r = recorder([{ body: REC }]);
    const pub = createPublicClient({ key: 'pub_abc', fetch: r.fetch });
    const rec = await pub.get('event', 'p1');
    expect(pub.id).toBe('https://api.vectros.ai|pub_abc');
    expect(rec).toEqual(REC);
    const call = r.calls[0] as Call;
    expect(call.url.origin).toBe('https://api.vectros.ai');
    expect(call.url.pathname).toBe('/v1/public/records/event/p1');
    expect(call.url.searchParams.get('k')).toBe('pub_abc');
    expect(call.headers.authorization).toBeUndefined();
  });

  it('list sends the one lookup field as a query parameter and returns the cursor; listAll pages to the end', async () => {
    const r = recorder([
      { body: { data: [REC], nextCursor: 'c2' } },
      { body: { data: [], nextCursor: 'c3' } },
      { body: { data: [{ ...REC, publicId: 'p2' }], nextCursor: null } },
    ]);
    const pub = createPublicClient({ key: 'pub_abc', baseUrl: 'https://api.example.test/', fetch: r.fetch });
    const all: string[] = [];
    for await (const rec of pub.listAll('event', { by: { city: 'Lisbon' }, limit: 1 })) all.push(rec.publicId);
    expect(all).toEqual(['p1', 'p2']);
    expect(r.calls.map((c) => c.url.searchParams.get('cursor'))).toEqual([null, 'c2', 'c3']);
    for (const c of r.calls) {
      expect(c.url.origin).toBe('https://api.example.test');
      expect(c.url.searchParams.get('city')).toBe('Lisbon');
      expect(c.url.searchParams.get('limit')).toBe('1');
    }
  });

  it('list refuses zero or two fields in `by`, and a reserved name', async () => {
    const pub = createPublicClient({ key: 'pub_abc', fetch: recorder([{ body: {} }]).fetch });
    await expect(pub.list('event', { by: {} })).rejects.toThrow(/exactly one lookup field/);
    await expect(pub.list('event', { by: { a: 1, b: 2 } })).rejects.toThrow(/exactly one lookup field/);
    await expect(pub.list('event', { by: { k: 'x' } })).rejects.toThrow(/cannot be a list field/);
  });

  it('search sends near.* as plain decimals and keeps distances', async () => {
    const r = recorder([{ body: { data: [{ ...REC, distanceMeters: 330 }], hasMore: false } }]);
    const pub = createPublicClient({ key: 'pub_abc', fetch: r.fetch });
    const page = await pub.search('event', { q: 'beach', mode: 'text', near: { lat: 38.72230001, lon: -9.1393, radius: 2000 }, limit: 5 });
    expect(page).toEqual({ data: [{ ...REC, distanceMeters: 330 }], hasMore: false });
    const call = r.calls[0] as Call;
    const q = call.url.searchParams;
    expect(call.url.pathname).toBe('/v1/public/search');
    expect([q.get('type'), q.get('q'), q.get('mode'), q.get('near.lat'), q.get('near.lon'), q.get('near.radius'), q.get('limit')])
      .toEqual(['event', 'beach', 'text', '38.7223', '-9.1393', '2000', '5']);
  });

  it('search sends each filter as filter.<field>', async () => {
    const r = recorder([{ body: { data: [], hasMore: false } }]);
    const pub = createPublicClient({ key: 'pub_abc', fetch: r.fetch });
    await pub.search('event', { q: 'beach', filters: { city: 'Lisbon', free: true } });
    const q = (r.calls[0] as Call).url.searchParams;
    expect([q.get('filter.city'), q.get('filter.free')]).toEqual(['Lisbon', 'true']);
  });

  it('search with a blank q sends no q parameter', async () => {
    const r = recorder([{ body: { data: [], hasMore: false } }, { body: { data: [], hasMore: false } }]);
    const pub = createPublicClient({ key: 'pub_abc', fetch: r.fetch });
    await pub.search('event', { q: '', filters: { city: 'Lisbon' } });
    await pub.search('event', { q: '   ', filters: { city: 'Lisbon' } });
    for (const call of r.calls as Call[]) expect(call.url.searchParams.has('q')).toBe(false);
  });

  it('search with filters and no q sends no q parameter', async () => {
    const r = recorder([{ body: { data: [], hasMore: false } }]);
    const pub = createPublicClient({ key: 'pub_abc', fetch: r.fetch });
    await pub.search('event', { filters: { city: 'Lisbon' } });
    const q = (r.calls[0] as Call).url.searchParams;
    expect([q.has('q'), q.get('filter.city')]).toEqual([false, 'Lisbon']);
  });

  it('search sends a range as filter.<field>.from and .to, and a one-sided range as one parameter', async () => {
    const r = recorder([{ body: { data: [], hasMore: false } }]);
    const pub = createPublicClient({ key: 'pub_abc', fetch: r.fetch });
    await pub.search('event', { q: 'beach', filters: { price: { from: 10, to: 20.5 }, day: { to: '2026-01-31' }, city: 'Lisbon', open: { from: null, to: -0 } as unknown as PublicRange } });
    const q = (r.calls[0] as Call).url.searchParams;
    expect([q.get('filter.price.from'), q.get('filter.price.to'), q.get('filter.day.to'), q.get('filter.city')])
      .toEqual(['10', '20.5', '2026-01-31', 'Lisbon']);
    expect([q.has('filter.day.from'), q.has('filter.price'), q.has('filter.day'), q.has('filter.open.from')]).toEqual([false, false, false, false]);
    expect(q.get('filter.open.to')).toBe('0');
  });

  it('search sends an instant filter, a range and a set as the spelled moments, and sortBy and order as query parameters', async () => {
    const r = recorder([{ body: { data: [], hasMore: false } }, { body: { data: [], hasMore: false } }]);
    const pub = createPublicClient({ key: 'pub_abc', fetch: r.fetch });
    const first = new Date('2026-11-20T00:00:00.000Z').toISOString();
    await pub.search('event', {
      filters: {
        startsAt: { from: first, to: '2026-11-20T23:59:59.999Z' },
        endsAt: '2026-11-20T09:30:00.000Z',
        shifts: { in: ['2026-11-25T12:00:00.000Z', '2026-11-22T08:00:00.000Z'] },
      },
      sortBy: 'startsAt',
      order: 'desc',
    });
    const q = (r.calls[0] as Call).url.searchParams;
    expect([q.get('filter.startsAt.from'), q.get('filter.startsAt.to'), q.get('filter.endsAt'), q.get('filter.shifts.in')])
      .toEqual(['2026-11-20T00:00:00.000Z', '2026-11-20T23:59:59.999Z', '2026-11-20T09:30:00.000Z', '2026-11-22T08:00:00.000Z,2026-11-25T12:00:00.000Z']);
    expect([q.get('sortBy'), q.get('order'), q.has('q')]).toEqual(['startsAt', 'desc', false]);
    await pub.search('event', { q: 'beach', sortBy: 'price' });
    const plain = (r.calls[1] as Call).url.searchParams;
    expect([plain.get('sortBy'), plain.has('order'), plain.get('q')]).toEqual(['price', false, 'beach']);
  });

  it('search without sortBy and order sends neither', async () => {
    const r = recorder([{ body: { data: [], hasMore: false } }]);
    const pub = createPublicClient({ key: 'pub_abc', fetch: r.fetch });
    await pub.search('event', { q: 'beach', filters: { city: 'Lisbon' } });
    const q = (r.calls[0] as Call).url.searchParams;
    expect([q.has('sortBy'), q.has('order')]).toEqual([false, false]);
  });

  it('search refuses, before any request, a range with no bound and a number bound the server would refuse', async () => {
    const r = recorder([]);
    const pub = createPublicClient({ key: 'pub_abc', fetch: r.fetch });
    for (const range of [{}, { from: undefined }, { to: null }] as unknown as PublicRange[]) {
      await expect(pub.search('event', { q: 'x', filters: { price: range } })).rejects.toThrow(RangeError);
    }
    for (const bad of [1e21, 1e-7, 0.1 + 0.2, Number.MAX_SAFE_INTEGER, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(pub.search('event', { q: 'x', filters: { price: { from: bad } } })).rejects.toThrow(RangeError);
    }
    expect(r.calls).toHaveLength(0);
  });

  it('search sends a set as one filter.<field>.in parameter, sorted and without duplicates', async () => {
    const r = recorder([{ body: { data: [], hasMore: false } }]);
    const pub = createPublicClient({ key: 'pub_abc', fetch: r.fetch });
    await pub.search('event', { q: 'beach', filters: { city: { in: ['York', 'Leeds', 'York', 'Bath'] }, price: { in: [10, -2.5, 3] } } });
    const q = (r.calls[0] as Call).url.searchParams;
    expect([q.get('filter.city.in'), q.get('filter.price.in')]).toEqual(['Bath,Leeds,York', '-2.5,3,10']);
    expect([q.has('filter.city'), q.has('filter.price')]).toEqual([false, false]);
  });

  it('a set orders by value when every value is a plain decimal, whatever their JavaScript type, as the server does', async () => {
    const r = recorder([{ body: { data: [], hasMore: false } }]);
    const pub = createPublicClient({ key: 'pub_abc', fetch: r.fetch });
    await pub.search('event', { q: 'x', filters: { zip: { in: ['10', '9'] }, code: { in: [10, 9, 9] }, word: { in: ['b', '10', 'a', '9'] }, accent: { in: ['z', 'é', 'e'] } } });
    const q = (r.calls[0] as Call).url.searchParams;
    expect([q.get('filter.zip.in'), q.get('filter.code.in'), q.get('filter.word.in'), q.get('filter.accent.in')]).toEqual(['9,10', '9,10', '10,9,a,b', 'e,z,é']);
  });

  it('a set is spelled exactly as the shared golden vectors say (the server tests read the same file)', async () => {
    const vectors = setOrderVectors as { cases: Array<{ values: string[]; canonical: string }> };
    expect(vectors.cases.length).toBeGreaterThan(10);
    for (const c of vectors.cases) {
      const r = recorder([{ body: { data: [], hasMore: false } }]);
      const pub = createPublicClient({ key: 'pub_abc', fetch: r.fetch });
      await pub.search('event', { q: 'x', filters: { f: { in: c.values } } });
      expect((r.calls[0] as Call).url.searchParams.get('filter.f.in'), JSON.stringify(c.values)).toBe(c.canonical);
    }
  });

  it('search refuses, before any request, a set the server cannot take', async () => {
    const r = recorder([]);
    const pub = createPublicClient({ key: 'pub_abc', fetch: r.fetch });
    const bad: PublicSet[] = [
      { in: [] }, { in: ['a,b'] }, { in: [''] }, { in: ['x'.repeat(129)] }, { in: Array.from({ length: 11 }, (_, i) => `v${i}`) },
      { in: [1e21] }, { in: ['\uD800'] },
    ];
    for (const set of bad) await expect(pub.search('event', { q: 'x', filters: { f: set } })).rejects.toThrow(RangeError);
    expect(r.calls).toHaveLength(0);
  });

  it('a server key sends its secret in the server-secret header', async () => {
    const r = recorder([{ body: REC }]);
    await onServer(async () => {
      const pub = createPublicClient({ key: 'pubs_abc', serverSecret: 'sec', fetch: r.fetch });
      await pub.get('event', 'p1');
    });
    expect((r.calls[0] as Call).headers[PUBLIC_SERVER_SECRET_HEADER.toLowerCase()]).toBe('sec');
  });

  it('a refusal surfaces as the SDK error, readable with statusCodeOf and errorCodeOf', async () => {
    const r = recorder([{ status: 503, body: { message: 'Public access is off', errorCode: 'PUBLIC_ACCESS_NOT_ENABLED' } }]);
    const pub = createPublicClient({ key: 'pub_abc', fetch: r.fetch, maxRetries: 0 });
    const err = await pub.get('event', 'p1').catch((e: unknown) => e);
    expect(statusCodeOf(err)).toBe(503);
    expect(errorCodeOf(err)).toBe('PUBLIC_ACCESS_NOT_ENABLED');
  });
});

describe('formatCoordinate', () => {
  it('writes at most 6 decimals, never exponent notation, and passes strings through', () => {
    expect(formatCoordinate(38.7223)).toBe('38.7223');
    expect(formatCoordinate(0.0000001)).toBe('0');
    expect(formatCoordinate(-0.0000001)).toBe('0');
    expect(formatCoordinate(10)).toBe('10');
    expect(formatCoordinate(-9.1234567)).toBe('-9.123457');
    expect(formatCoordinate('38.7')).toBe('38.7');
    for (const bad of ['1e-7', '38.1234567', 'abc', '']) expect(() => formatCoordinate(bad)).toThrow(RangeError);
    expect(() => formatCoordinate(Number.NaN)).toThrow(RangeError);
  });
});
