// ---------------------------------------------------------------------------
// Inference stream reduction — the pure heart of a streaming AI surface.
// Framework-free so the event-folding logic is unit-testable in isolation;
// the React layer (useInferenceStream) just drives the async iteration and
// applies this reducer. Promoted from app.vectros.ai, where this was already
// real, working, and unit-tested (the same code-reuse story schema-ui's
// promotion followed) — a second reference app (casework-spa) hitting the
// identical streaming-SSE shape is what surfaced it as shared, not app-local.
//
// All three inference endpoints (chat / RAG / document-ask) return an SSE
// `Stream<T>` (an AsyncIterable) of a **discriminated union keyed by `event`**:
//   - content_delta  → a chunk of generated text (all three)
//   - done           → terminal usage/billing summary (all three)
//   - error          → terminal error (all three)
//   - search_results / truncation_warning → RAG only (grounding + budget trim)
//   - document_context → document-ask only (what doc was loaded)
// We fold the stream into one flat state the UI renders.
// ---------------------------------------------------------------------------

import type { Vectros } from '@vectros-ai/sdk';

// The SDK exposes the per-endpoint stream-event *unions* (ChatStreamEvent, …) as
// namespaces (values), not as types on the `Vectros` namespace, so we model the
// discriminated wrapper locally — it's our consumption contract — while reusing
// the SDK's leaf PAYLOAD types (DoneEvent / RagSearchResult / DocumentContextEvent),
// which ARE plain type exports. The runtime events match structurally.
type DoneEvent = Vectros.DoneEvent;
type RagSearchResult = Vectros.RagSearchResult;
type DocumentContextEvent = Vectros.DocumentContextEvent;

/** RAG context-window truncation notice (SDK `TruncationWarningEvent`). */
export interface TruncationWarning {
  readonly resultsRequested: number;
  readonly resultsUsed: number;
  readonly reason: string;
}

/** The union of every event the three inference endpoints can emit (keyed by `event`). */
export type InferenceStreamEvent =
  | { readonly event: 'content_delta'; readonly delta: string }
  | ({ readonly event: 'done' } & DoneEvent)
  | { readonly event: 'error'; readonly message: string; readonly code: string }
  | {
      readonly event: 'search_results';
      readonly results: RagSearchResult[];
      readonly totalResults: number;
      readonly searchTimeMs: number;
    }
  | ({ readonly event: 'truncation_warning' } & TruncationWarning)
  | ({ readonly event: 'document_context' } & DocumentContextEvent);

export type InferenceStreamStatus = 'idle' | 'streaming' | 'done' | 'error';

/** The folded view of an in-flight (or finished) inference stream. */
export interface InferenceStreamState {
  readonly status: InferenceStreamStatus;
  /** Accumulated assistant text (concatenated content_delta chunks). */
  readonly text: string;
  /** Terminal error (status === 'error'). */
  readonly error?: { readonly message: string; readonly code: string };
  /** Terminal usage/billing summary (status === 'done'). */
  readonly usage?: DoneEvent;
  /** RAG grounding results — drives the citations rail. */
  readonly citations?: ReadonlyArray<RagSearchResult>;
  /** RAG search metadata (total hits + search latency). */
  readonly search?: { readonly totalResults: number; readonly searchTimeMs: number };
  /** RAG context-window truncation notice. */
  readonly truncation?: TruncationWarning;
  /** Document-ask: which document's text was loaded as context. */
  readonly documentContext?: DocumentContextEvent;
}

export const INITIAL_INFERENCE_STREAM_STATE: InferenceStreamState = {
  status: 'idle',
  text: '',
};

/** A fresh streaming state — used when a run starts (before the first event). */
export function startedInferenceStreamState(): InferenceStreamState {
  return { status: 'streaming', text: '' };
}

/**
 * Fold one stream event into the state (pure). Unknown event types are ignored
 * (forward-compatible if the backend adds one), preserving the current state.
 */
export function reduceInferenceEvent(
  state: InferenceStreamState,
  event: InferenceStreamEvent,
): InferenceStreamState {
  switch (event.event) {
    case 'content_delta':
      return { ...state, status: 'streaming', text: state.text + (event.delta ?? '') };
    case 'search_results':
      return {
        ...state,
        citations: event.results,
        search: { totalResults: event.totalResults, searchTimeMs: event.searchTimeMs },
      };
    case 'truncation_warning':
      return { ...state, truncation: event };
    case 'document_context':
      return { ...state, documentContext: event };
    case 'done':
      return { ...state, status: 'done', usage: event };
    case 'error':
      return { ...state, status: 'error', error: { message: event.message, code: event.code } };
    default:
      return state;
  }
}
