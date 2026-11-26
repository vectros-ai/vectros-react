// ---------------------------------------------------------------------------
// usePublicRecord / usePublicList over a fake PublicClient: the record query waits for an id and does not retry a
// 404; the list query pages with the client's cursor.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { usePublicList, usePublicRecord } from './hooks';
import type { PublicClient } from './publicClient';

function wrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const qc = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  return ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function fakeClient(over: Partial<PublicClient>, id = 'https://api.example.test|pub_a'): PublicClient {
  return { id, get: vi.fn(), list: vi.fn(), listAll: vi.fn(), search: vi.fn(), ...over } as unknown as PublicClient;
}

describe('usePublicRecord', () => {
  it('stays idle without an id, then reads the record', async () => {
    const get = vi.fn().mockResolvedValue({ publicId: 'p1', type: 'event', fields: { title: 't' } });
    const client = fakeClient({ get });
    const { result, rerender } = renderHook(({ id }: { id?: string }) => usePublicRecord(client, 'event', id), {
      wrapper: wrapper(),
      initialProps: {} as { id?: string },
    });
    expect(get).not.toHaveBeenCalled();
    rerender({ id: 'p1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.publicId).toBe('p1');
    expect(get).toHaveBeenCalledWith('event', 'p1', expect.objectContaining({ abortSignal: expect.anything() }));
  });

  it('two clients (two app contexts) on one page never share a cached record', async () => {
    const a = fakeClient({ get: vi.fn().mockResolvedValue({ publicId: 'p1', type: 'event', fields: { from: 'a' } }) }, 'x|pub_a');
    const b = fakeClient({ get: vi.fn().mockResolvedValue({ publicId: 'p1', type: 'event', fields: { from: 'b' } }) }, 'x|pub_b');
    const w = wrapper();
    const ra = renderHook(() => usePublicRecord(a, 'event', 'p1'), { wrapper: w });
    const rb = renderHook(() => usePublicRecord(b, 'event', 'p1'), { wrapper: w });
    await waitFor(() => expect(ra.result.current.isSuccess && rb.result.current.isSuccess).toBe(true));
    expect(ra.result.current.data?.fields).toEqual({ from: 'a' });
    expect(rb.result.current.data?.fields).toEqual({ from: 'b' });
  });

  it('does not retry on its own (the client already retries what is worth retrying)', async () => {
    const get = vi.fn().mockRejectedValue(Object.assign(new Error('Not found'), { statusCode: 404 }));
    const { result } = renderHook(() => usePublicRecord(fakeClient({ get }), 'event', 'gone'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe('usePublicList', () => {
  it('pages with the cursor until there is none', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ publicId: 'a', type: 'event', fields: {} }], nextCursor: 'c2' })
      .mockResolvedValueOnce({ data: [{ publicId: 'b', type: 'event', fields: {} }], nextCursor: null });
    const { result } = renderHook(() => usePublicList(fakeClient({ list }), 'event', { by: { city: 'Lisbon' }, limit: 1 }), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(true);
    await act(async () => { await result.current.fetchNextPage(); });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    expect(result.current.hasNextPage).toBe(false);
    expect(list.mock.calls[1]?.[1]).toMatchObject({ by: { city: 'Lisbon' }, limit: 1, cursor: 'c2' });
  });
});
