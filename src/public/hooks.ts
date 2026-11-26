// ---------------------------------------------------------------------------
// React Query hooks over a public client: one public record, and a type's public records listed by one lookup field,
// page after page. They need a QueryClientProvider above them, as every query hook does, and take the client you
// created with createPublicClient, so one page can read from several app contexts (each client's id is part of its
// cache keys). They do not retry on their own: the client already retries a 429 or a 5xx answer.
// ---------------------------------------------------------------------------

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { PublicClient, PublicListOptions, PublicRecord, PublicRecordPage } from './publicClient';

/** The query key prefix every public-read hook uses: invalidate `['vectros-public']` to refetch them all. */
export const PUBLIC_QUERY_KEY = 'vectros-public';

/** One public record. Pass `publicId: undefined` to wait (the query stays disabled). */
export function usePublicRecord(client: PublicClient, type: string, publicId: string | undefined, options: { staleTimeMs?: number } = {}) {
  return useQuery<PublicRecord>({
    queryKey: [PUBLIC_QUERY_KEY, client.id, 'record', type, publicId],
    queryFn: ({ signal }) => client.get(type, publicId as string, { abortSignal: signal }),
    enabled: typeof publicId === 'string' && publicId.length > 0,
    ...(options.staleTimeMs !== undefined ? { staleTime: options.staleTimeMs } : {}),
    retry: false,
  });
}

/** A type's public records listed by one published lookup field; `fetchNextPage` loads the next page while `hasNextPage`. */
export function usePublicList(client: PublicClient, type: string, options: Omit<PublicListOptions, 'cursor'>, query: { staleTimeMs?: number } = {}) {
  return useInfiniteQuery<PublicRecordPage, Error, { pages: PublicRecordPage[] }, unknown[], string | undefined>({
    queryKey: [PUBLIC_QUERY_KEY, client.id, 'list', type, options.by, options.limit],
    retry: false,
    queryFn: ({ pageParam, signal }) => client.list(type, { ...options, ...(pageParam ? { cursor: pageParam } : {}) }, { abortSignal: signal }),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    ...(query.staleTimeMs !== undefined ? { staleTime: query.staleTimeMs } : {}),
  });
}
