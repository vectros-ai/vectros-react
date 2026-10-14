// ---------------------------------------------------------------------------
// Comment-frame tolerance, end to end through the real SDK reader.
//
// The streaming inference routes may interleave SSE comment lines (a line that
// starts with a colon) with events. A comment never dispatches an event, so the
// folded state must be identical with and without them. useInferenceStream
// consumes the SDK's decoded iterable and never sees bytes, so this drives the
// real SDK stream reader with a byte stream containing comment frames: before
// the first event, between events, and right before `done`.
// ---------------------------------------------------------------------------

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { VectrosClient } from '@vectros-ai/sdk';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { reduceInferenceEvent, startedInferenceStreamState } from './inferenceStream';
import type { InferenceStreamEvent, InferenceStreamState } from './inferenceStream';
import { useInferenceStream } from './useInferenceStream';

const COMMENT = ': keepalive\n\n';

function frame(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, event: type, ...payload })}\n\n`;
}

const CONTEXT_FRAME = frame('document_context', { documentId: 'd1', title: 'T', textBytes: 4, model: 'm' });
const HEL_FRAME = frame('content_delta', { delta: 'Hel' });
const LO_FRAME = frame('content_delta', { delta: 'lo' });
const DONE_FRAME = frame('done', {
  inputTokens: 1,
  outputTokens: 2,
  model: 'm',
  platformCreditsCharged: 0,
  inferenceBalanceCentsCharged: 0,
});

const EVENT_FRAMES: string[] = [CONTEXT_FRAME, HEL_FRAME, LO_FRAME, DONE_FRAME];

const WITH_COMMENTS: string[] = [
  COMMENT,
  CONTEXT_FRAME,
  COMMENT,
  HEL_FRAME,
  COMMENT,
  COMMENT,
  LO_FRAME,
  COMMENT,
  DONE_FRAME,
];

async function withServer<T>(
  chunks: string[],
  withClient: (client: VectrosClient) => Promise<T>,
): Promise<T> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    for (const c of chunks) res.write(c);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  try {
    return await withClient(
      new VectrosClient({ token: 'sk_test', environment: url, baseUrl: url, maxRetries: 0 }),
    );
  } finally {
    server.close();
  }
}

async function foldViaReducer(chunks: string[]): Promise<InferenceStreamState> {
  return withServer(chunks, async (client) => {
    const stream = await client.inference.documentAsk({ id: 'd1', prompt: 'q' } as never);
    let state = startedInferenceStreamState();
    for await (const event of stream as unknown as AsyncIterable<InferenceStreamEvent>) {
      state = reduceInferenceEvent(state, event);
    }
    return state;
  });
}

describe('SSE comment frames through the real SDK reader', () => {
  it('folds to the same state with and without comment frames', async () => {
    const baseline = await foldViaReducer(EVENT_FRAMES);
    const withComments = await foldViaReducer(WITH_COMMENTS);
    expect(baseline.status).toBe('done');
    expect(baseline.text).toBe('Hello');
    expect(withComments).toEqual(baseline);
  });

  it('useInferenceStream reaches the same final state when the stream carries comment frames', async () => {
    const run = async (chunks: string[]) =>
      withServer(chunks, async (client) => {
        const { result } = renderHook(() => useInferenceStream());
        act(() => {
          result.current.run(({ abortSignal }) =>
            client.inference.documentAsk({ id: 'd1', prompt: 'q' } as never, {
              abortSignal,
            }) as unknown as Promise<AsyncIterable<InferenceStreamEvent>>,
          );
        });
        await waitFor(() => expect(result.current.state.status).toBe('done'));
        return result.current.state;
      });

    const baseline = await run(EVENT_FRAMES);
    const withComments = await run(WITH_COMMENTS);
    expect(baseline.text).toBe('Hello');
    expect(withComments).toEqual(baseline);
  });
});
