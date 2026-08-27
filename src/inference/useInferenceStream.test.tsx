// ---------------------------------------------------------------------------
// useInferenceStream tests — drives a (mock) async-iterable stream through the
// reducer, and verifies the cancel/stale-run guard stops applying events.
// Promoted from app.vectros.ai alongside the hook itself.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import { useInferenceStream } from './useInferenceStream';
import type { InferenceStreamEvent } from './inferenceStream';

const ev = (e: unknown): InferenceStreamEvent => e as InferenceStreamEvent;
const DONE = ev({
  event: 'done',
  inputTokens: 1,
  outputTokens: 1,
  model: 'm',
  platformCreditsCharged: 0,
  inferenceBalanceCentsCharged: 0,
});

async function* fromArray(events: InferenceStreamEvent[]): AsyncGenerator<InferenceStreamEvent> {
  for (const e of events) yield e;
}

describe('useInferenceStream', () => {
  it('accumulates deltas and reaches done', async () => {
    const { result } = renderHook(() => useInferenceStream());
    act(() => {
      result.current.run(() =>
        Promise.resolve(
          fromArray([
            ev({ event: 'content_delta', delta: 'Hel' }),
            ev({ event: 'content_delta', delta: 'lo' }),
            DONE,
          ]),
        ),
      );
    });
    await waitFor(() => expect(result.current.state.status).toBe('done'));
    expect(result.current.state.text).toBe('Hello');
  });

  it('surfaces an error event', async () => {
    const { result } = renderHook(() => useInferenceStream());
    act(() => {
      result.current.run(() =>
        Promise.resolve(
          fromArray([ev({ event: 'error', message: 'boom', code: 'inference_error' })]),
        ),
      );
    });
    await waitFor(() => expect(result.current.state.status).toBe('error'));
    expect(result.current.state.error?.message).toBe('boom');
  });

  it('surfaces a runner-promise rejection as a stream error', async () => {
    const { result } = renderHook(() => useInferenceStream());
    act(() => {
      result.current.run(() => Promise.reject(new Error('net down')));
    });
    await waitFor(() => expect(result.current.state.status).toBe('error'));
    expect(result.current.state.error).toEqual({ message: 'net down', code: 'stream_error' });
  });

  it('cancel stops applying further events (stale-run guard)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    async function* gated(): AsyncGenerator<InferenceStreamEvent> {
      yield ev({ event: 'content_delta', delta: 'partial' });
      await gate;
      yield ev({ event: 'content_delta', delta: ' more' });
    }

    const { result } = renderHook(() => useInferenceStream());
    act(() => {
      result.current.run(() => Promise.resolve(gated()));
    });
    await waitFor(() => expect(result.current.state.text).toBe('partial'));

    act(() => result.current.cancel());
    expect(result.current.state.status).toBe('idle');

    // The generator resumes, but the stale-run guard must drop the late event.
    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.state.text).toBe('partial');
  });

  it('reset returns to the idle state', async () => {
    const { result } = renderHook(() => useInferenceStream());
    act(() => {
      result.current.run(() =>
        Promise.resolve(fromArray([ev({ event: 'content_delta', delta: 'x' }), DONE])),
      );
    });
    await waitFor(() => expect(result.current.state.status).toBe('done'));
    act(() => result.current.reset());
    expect(result.current.state).toEqual({ status: 'idle', text: '' });
  });
});
