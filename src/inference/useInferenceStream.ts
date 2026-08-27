// ---------------------------------------------------------------------------
// useInferenceStream — drives an SSE inference stream and folds it into render
// state via the pure `reduceInferenceEvent` reducer. Promoted from
// app.vectros.ai alongside inferenceStream.ts — see that file's header.
//
// Endpoint-agnostic: the caller supplies a *runner* thunk that
// makes the SDK call, so the same hook serves chat / RAG / document-ask and is
// trivially mockable in tests.
//
// Cancellation: each run gets an AbortController whose signal is handed to the
// runner (→ the SDK RequestOptions.abortSignal); `cancel()` aborts it AND bumps
// a run-id so any in-flight async iteration stops applying events even if the
// transport keeps yielding.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  INITIAL_INFERENCE_STREAM_STATE,
  reduceInferenceEvent,
  startedInferenceStreamState,
} from './inferenceStream';
import type { InferenceStreamEvent, InferenceStreamState } from './inferenceStream';

/**
 * Makes the inference stream. Receives the run's abort signal to wire into the
 * SDK call's `RequestOptions`, e.g.
 * `({ abortSignal }) => client.inference.ragInference(req, { abortSignal })`.
 */
export type InferenceStreamRunner = (opts: {
  abortSignal: AbortSignal;
}) => Promise<AsyncIterable<InferenceStreamEvent>>;

export interface UseInferenceStream {
  readonly state: InferenceStreamState;
  readonly isStreaming: boolean;
  /** Start a run, aborting any in-flight run first. */
  readonly run: (runner: InferenceStreamRunner) => void;
  /** Stop the in-flight run — aborts the request and stops applying events. */
  readonly cancel: () => void;
  /** Reset back to the idle state. */
  readonly reset: () => void;
}

export function useInferenceStream(): UseInferenceStream {
  const [state, setState] = useState<InferenceStreamState>(INITIAL_INFERENCE_STREAM_STATE);
  const controllerRef = useRef<AbortController | null>(null);
  const runIdRef = useRef(0);

  // Abort the in-flight request + invalidate its iteration (stale-run guard).
  const stop = useCallback((): void => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    runIdRef.current += 1;
  }, []);

  const run = useCallback(
    (runner: InferenceStreamRunner): void => {
      stop();
      const controller = new AbortController();
      controllerRef.current = controller;
      runIdRef.current += 1;
      const myRunId = runIdRef.current;
      setState(startedInferenceStreamState());

      void (async () => {
        try {
          const stream = await runner({ abortSignal: controller.signal });
          for await (const event of stream) {
            if (runIdRef.current !== myRunId) return; // superseded or cancelled
            setState((prev) => reduceInferenceEvent(prev, event));
          }
        } catch (err) {
          if (runIdRef.current !== myRunId) return; // cancelled — swallow
          const message = err instanceof Error ? err.message : 'Inference stream failed.';
          setState((prev) =>
            prev.status === 'done'
              ? prev
              : { ...prev, status: 'error', error: { message, code: 'stream_error' } },
          );
        }
      })();
    },
    [stop],
  );

  const cancel = useCallback((): void => {
    stop();
    // Keep the partial text; just drop the streaming indicator.
    setState((prev) => (prev.status === 'streaming' ? { ...prev, status: 'idle' } : prev));
  }, [stop]);

  const reset = useCallback((): void => {
    stop();
    setState(INITIAL_INFERENCE_STREAM_STATE);
  }, [stop]);

  // Abort any in-flight run on unmount.
  useEffect(
    () => () => {
      controllerRef.current?.abort();
    },
    [],
  );

  return { state, isStreaming: state.status === 'streaming', run, cancel, reset };
}
