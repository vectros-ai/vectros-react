// ---------------------------------------------------------------------------
// inferenceStream reducer tests — folding the discriminated SSE event union
// (chat / RAG / document-ask) into one render state. Promoted from
// app.vectros.ai alongside the reducer itself.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import {
  INITIAL_INFERENCE_STREAM_STATE,
  reduceInferenceEvent,
  startedInferenceStreamState,
} from './inferenceStream';
import type { InferenceStreamEvent } from './inferenceStream';

const ev = (e: unknown): InferenceStreamEvent => e as InferenceStreamEvent;

const DONE = ev({
  event: 'done',
  inputTokens: 10,
  outputTokens: 5,
  model: 'claude-haiku-4-5',
  platformCreditsCharged: 2,
  inferenceBalanceCentsCharged: 0,
});

/** Fold a sequence of events from the initial state. */
function fold(events: InferenceStreamEvent[]) {
  return events.reduce(reduceInferenceEvent, startedInferenceStreamState());
}

describe('reduceInferenceEvent', () => {
  it('accumulates content_delta into text and stays streaming', () => {
    const s = fold([
      ev({ event: 'content_delta', delta: 'Hel' }),
      ev({ event: 'content_delta', delta: 'lo' }),
    ]);
    expect(s.text).toBe('Hello');
    expect(s.status).toBe('streaming');
  });

  it('captures the done usage and marks done', () => {
    const s = fold([ev({ event: 'content_delta', delta: 'Hi' }), DONE]);
    expect(s.status).toBe('done');
    expect(s.text).toBe('Hi');
    expect(s.usage?.outputTokens).toBe(5);
    expect(s.usage?.platformCreditsCharged).toBe(2);
  });

  it('marks error with message + code', () => {
    const s = fold([ev({ event: 'error', message: 'Inference unavailable', code: 'inference_error' })]);
    expect(s.status).toBe('error');
    expect(s.error).toEqual({ message: 'Inference unavailable', code: 'inference_error' });
  });

  it('captures RAG search_results as citations + search meta', () => {
    const s = fold([
      ev({
        event: 'search_results',
        results: [
          { documentId: 'doc_1', score: 0.9, snippet: 'a' },
          { documentId: 'doc_2', score: 0.5, snippet: 'b' },
        ],
        totalResults: 2,
        searchTimeMs: 42,
      }),
      ev({ event: 'content_delta', delta: 'Answer' }),
      DONE,
    ]);
    expect(s.citations?.map((c) => c.documentId)).toEqual(['doc_1', 'doc_2']);
    expect(s.search).toEqual({ totalResults: 2, searchTimeMs: 42 });
    expect(s.text).toBe('Answer');
    expect(s.status).toBe('done');
  });

  it('captures RAG truncation_warning', () => {
    const s = fold([
      ev({
        event: 'truncation_warning',
        resultsRequested: 10,
        resultsUsed: 6,
        reason: 'context_window_budget',
      }),
    ]);
    expect(s.truncation?.resultsUsed).toBe(6);
  });

  it('captures document-ask document_context', () => {
    const s = fold([
      ev({
        event: 'document_context',
        documentId: 'doc_9',
        title: 'Report',
        textBytes: 1234,
        model: 'm',
      }),
    ]);
    expect(s.documentContext?.documentId).toBe('doc_9');
    expect(s.documentContext?.title).toBe('Report');
  });

  it('ignores unknown events (forward-compatible)', () => {
    const s = reduceInferenceEvent(
      INITIAL_INFERENCE_STREAM_STATE,
      ev({ event: 'mystery_future_event' }),
    );
    expect(s).toBe(INITIAL_INFERENCE_STREAM_STATE);
  });
});
