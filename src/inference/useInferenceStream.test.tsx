// ---------------------------------------------------------------------------
// useInferenceStream tests — drives a (mock) async-iterable stream through the
// reducer, and verifies the cancel/stale-run guard stops applying events.
// Promoted from app.vectros.ai alongside the hook itself.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { Vectros, VectrosTimeoutError } from '@vectros-ai/sdk';

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

// A stream that yields `events`, then rejects with `error`. `thrown()` resolves once the
// rejection has been delivered to the hook, so a test needs no timer: the hook's own
// handler is attached to the same promise before the test's, and runs first.
function throwsAfter(
  events: InferenceStreamEvent[],
  error: unknown,
): { iterable: AsyncIterable<InferenceStreamEvent>; thrown: () => Promise<void> } {
  let index = 0;
  let rejection: Promise<never> | undefined;
  const iterable: AsyncIterable<InferenceStreamEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResult<InferenceStreamEvent>> => {
        if (index < events.length) {
          return Promise.resolve({ done: false, value: events[index++] as InferenceStreamEvent });
        }
        rejection = Promise.reject(error);
        return rejection;
      },
    }),
  };
  return {
    iterable,
    thrown: async () => {
      await rejection?.catch(() => undefined);
    },
  };
}

// A runner promise the test rejects itself, after the run was cancelled or superseded.
function deferredRunner(): {
  promise: Promise<AsyncIterable<InferenceStreamEvent>>;
  rejectWith: (error: unknown) => Promise<void>;
} {
  let reject!: (error: unknown) => void;
  const promise = new Promise<AsyncIterable<InferenceStreamEvent>>((_resolve, rej) => {
    reject = rej;
  });
  return {
    promise,
    rejectWith: async (error) => {
      reject(error);
      await promise.catch(() => undefined);
    },
  };
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

  it('leaves a stream error event exactly as the event carries it', async () => {
    const { result } = renderHook(() => useInferenceStream());
    act(() => {
      result.current.run(() =>
        Promise.resolve(
          fromArray([ev({ event: 'error', message: 'boom', code: 'inference_error' })]),
        ),
      );
    });
    await waitFor(() => expect(result.current.state.status).toBe('error'));
    expect(result.current.state.error).toStrictEqual({ message: 'boom', code: 'inference_error' });
  });

  it('surfaces a runner-promise rejection as a stream error', async () => {
    const { result } = renderHook(() => useInferenceStream());
    act(() => {
      result.current.run(() => Promise.reject(new Error('net down')));
    });
    await waitFor(() => expect(result.current.state.status).toBe('error'));
    expect(result.current.state.error).toStrictEqual({ message: 'net down', code: 'stream_error' });
  });

  // The errors below are the SDK's real classes, so the fields the hook reads
  // (`statusCode` and `body.errorCode`) are checked against what the SDK sets.
  describe('a request refused before the stream starts', () => {
    it('carries the HTTP status and keeps the SDK message', async () => {
      const refusal = new Vectros.ForbiddenError({ message: 'Not allowed', requestId: 'req-1' });
      const { result } = renderHook(() => useInferenceStream());
      act(() => {
        result.current.run(() => Promise.reject(refusal));
      });
      await waitFor(() => expect(result.current.state.status).toBe('error'));
      expect(result.current.state.error).toStrictEqual({
        message: refusal.message,
        code: 'stream_error',
        status: 403,
        detail: 'Not allowed',
      });
      expect(result.current.state.error?.message).toContain('Status code: 403');
    });

    it('carries the status and the API errorCode when the response names one', async () => {
      const refusal = new Vectros.TooManyRequestsError({
        message: 'Slow down',
        errorCode: 'RATE_LIMITED',
        requestId: 'req-2',
      });
      const { result } = renderHook(() => useInferenceStream());
      act(() => {
        result.current.run(() => Promise.reject(refusal));
      });
      await waitFor(() => expect(result.current.state.status).toBe('error'));
      expect(result.current.state.error).toStrictEqual({
        message: refusal.message,
        code: 'stream_error',
        status: 429,
        errorCode: 'RATE_LIMITED',
        detail: 'Slow down',
      });
    });

    it('carries the API message as detail, without the SDK wrapper text', async () => {
      const refusal = new Vectros.TooManyRequestsError({
        message: '  Your pre-paid inference balance is busy. This is not a shortage: retry in a moment.  ',
        errorCode: 'BALANCE_BUSY',
      });
      const { result } = renderHook(() => useInferenceStream());
      act(() => {
        result.current.run(() => Promise.reject(refusal));
      });
      await waitFor(() => expect(result.current.state.status).toBe('error'));
      expect(result.current.state.error?.detail).toBe(
        'Your pre-paid inference balance is busy. This is not a shortage: retry in a moment.',
      );
      expect(result.current.state.error?.detail).not.toMatch(/Status code|Body:/);
    });

    it('omits detail when the response carries no message, or none that is text', async () => {
      for (const body of [{ errorCode: 'RATE_LIMITED' }, { message: '   ' }, { message: 7 }, undefined]) {
        const { result } = renderHook(() => useInferenceStream());
        act(() => {
          result.current.run(() => Promise.reject(new Vectros.TooManyRequestsError(body)));
        });
        await waitFor(() => expect(result.current.state.status).toBe('error'));
        expect(result.current.state.error).not.toHaveProperty('detail');
        expect(result.current.state.error?.status).toBe(429);
      }
    });

    it('omits detail for a failure that is not an API response', async () => {
      const { result } = renderHook(() => useInferenceStream());
      act(() => {
        result.current.run(() => Promise.reject(new TypeError('Failed to fetch')));
      });
      await waitFor(() => expect(result.current.state.status).toBe('error'));
      expect(result.current.state.error).toStrictEqual({ message: 'Failed to fetch', code: 'stream_error' });
    });

    it('omits errorCode when the response body names none', async () => {
      const refusal = new Vectros.NotFoundError({ message: 'No such model' });
      const { result } = renderHook(() => useInferenceStream());
      act(() => {
        result.current.run(() => Promise.reject(refusal));
      });
      await waitFor(() => expect(result.current.state.status).toBe('error'));
      expect(result.current.state.error).not.toHaveProperty('errorCode');
      expect(result.current.state.error?.status).toBe(404);
    });

    it('carries the status of an SDK error thrown while the stream is being read', async () => {
      async function* failing(): AsyncGenerator<InferenceStreamEvent> {
        yield ev({ event: 'content_delta', delta: 'partial' });
        throw new Vectros.ConflictError({ message: 'Busy', errorCode: 'RESOURCE_IN_USE' });
      }
      const { result } = renderHook(() => useInferenceStream());
      act(() => {
        result.current.run(() => Promise.resolve(failing()));
      });
      await waitFor(() => expect(result.current.state.status).toBe('error'));
      expect(result.current.state.text).toBe('partial');
      expect(result.current.state.error).toMatchObject({
        code: 'stream_error',
        status: 409,
        errorCode: 'RESOURCE_IN_USE',
      });
    });

    it('keeps a finished answer when an error is thrown after done', async () => {
      const stream = throwsAfter(
        [ev({ event: 'content_delta', delta: 'answer' }), DONE],
        new Vectros.TooManyRequestsError({ message: 'Slow down', errorCode: 'RATE_LIMITED' }),
      );
      const { result } = renderHook(() => useInferenceStream());
      act(() => {
        result.current.run(() => Promise.resolve(stream.iterable));
      });
      await act(async () => {
        await stream.thrown();
      });
      expect(result.current.state.status).toBe('done');
      expect(result.current.state.text).toBe('answer');
      expect(result.current.state.error).toBeUndefined();
    });

    it('lets a thrown error replace an earlier error event in the same run', async () => {
      const stream = throwsAfter(
        [ev({ event: 'error', message: 'boom', code: 'inference_error' })],
        new Vectros.TooManyRequestsError({ message: 'Slow down', errorCode: 'RATE_LIMITED' }),
      );
      const { result } = renderHook(() => useInferenceStream());
      act(() => {
        result.current.run(() => Promise.resolve(stream.iterable));
      });
      await act(async () => {
        await stream.thrown();
      });
      expect(result.current.state.status).toBe('error');
      expect(result.current.state.error).toMatchObject({
        code: 'stream_error',
        status: 429,
        errorCode: 'RATE_LIMITED',
      });
    });

    it('ignores an SDK error from a run that was cancelled', async () => {
      const pending = deferredRunner();
      const { result } = renderHook(() => useInferenceStream());
      act(() => {
        result.current.run(() => pending.promise);
      });
      act(() => result.current.cancel());
      await act(async () => {
        await pending.rejectWith(new Vectros.TooManyRequestsError({ errorCode: 'RATE_LIMITED' }));
      });
      expect(result.current.state.status).toBe('idle');
      expect(result.current.state.error).toBeUndefined();
    });

    it('ignores an SDK error from a run that a newer run superseded', async () => {
      const first = deferredRunner();
      const { result } = renderHook(() => useInferenceStream());
      act(() => {
        result.current.run(() => first.promise);
      });
      act(() => {
        result.current.run(() => new Promise<AsyncIterable<InferenceStreamEvent>>(() => undefined));
      });
      await act(async () => {
        await first.rejectWith(new Vectros.ForbiddenError({ message: 'Not allowed' }));
      });
      expect(result.current.state.status).toBe('streaming');
      expect(result.current.state.error).toBeUndefined();
    });

    it.each([
      ['a string', 'boom'],
      ['null', null],
    ])('uses the fallback message and no structured fields when %s is thrown', async (_label, thrown) => {
      const { result } = renderHook(() => useInferenceStream());
      act(() => {
        result.current.run(() => Promise.reject(thrown));
      });
      await waitFor(() => expect(result.current.state.status).toBe('error'));
      expect(result.current.state.error).toStrictEqual({
        message: 'Inference stream failed.',
        code: 'stream_error',
      });
    });

    it('reads the two fields independently, from a thrown object that is not an Error', async () => {
      const { result, rerender } = renderHook(() => useInferenceStream());
      act(() => {
        result.current.run(() => Promise.reject({ statusCode: 502 }));
      });
      await waitFor(() => expect(result.current.state.status).toBe('error'));
      expect(result.current.state.error).toStrictEqual({
        message: 'Inference stream failed.',
        code: 'stream_error',
        status: 502,
      });

      act(() => {
        result.current.run(() => Promise.reject({ body: { errorCode: 'QUOTA_EXHAUSTED' } }));
      });
      rerender();
      await waitFor(() =>
        expect(result.current.state.error).toStrictEqual({
          message: 'Inference stream failed.',
          code: 'stream_error',
          errorCode: 'QUOTA_EXHAUSTED',
        }),
      );
    });

    it('leaves status and errorCode out for a failure with no response', async () => {
      const timeout = new VectrosTimeoutError('Timeout exceeded when calling POST /v1/inference/chat');
      const { result } = renderHook(() => useInferenceStream());
      act(() => {
        result.current.run(() => Promise.reject(timeout));
      });
      await waitFor(() => expect(result.current.state.status).toBe('error'));
      expect(result.current.state.error).toStrictEqual({
        message: timeout.message,
        code: 'stream_error',
      });
    });
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
