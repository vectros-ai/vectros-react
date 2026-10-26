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
//   - reasoning_delta → a chunk of the model's reasoning, sent only when the request
//                       asked for it (all three); never part of the answer text
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
  | { readonly event: 'reasoning_delta'; readonly delta: string }
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

/**
 * The terminal error of an inference stream.
 *
 * It has two sources, and one run can produce both; the later one replaces the
 * earlier:
 * - An `error` event in the stream. `code` is the event's own machine-readable
 *   code (for example `inference_error`), and `status` and `errorCode` are
 *   absent.
 * - An error thrown by the runner, or while the stream is being read (a request
 *   the API refused before the stream starts, with HTTP 400, 403, 404, 409, 429,
 *   5xx and so on, surfaces this way; `state.text` keeps what had arrived).
 *   `code` is `'stream_error'`. `message` is the thrown error's message (for an
 *   SDK error that is the SDK's multi-line text, status and body included), or
 *   `'Inference stream failed.'` when what was thrown is not an `Error`.
 *   `status`, `errorCode` and `detail` carry the structured fields of the thrown
 *   error when it has them, so an app can choose its own copy without parsing `message`.
 */
export interface InferenceStreamError {
  readonly message: string;
  readonly code: string;
  /** HTTP status of the thrown error, when it carries one. Absent for a stream `error` event or a failure with no response. */
  readonly status?: number;
  /**
   * The API's own machine-readable `errorCode` from the error response body
   * (for example `RATE_LIMITED`). Absent when the response names no cause —
   * many 4xx responses carry only a message — so treat `undefined` as
   * "unspecified", and an unrecognised value as unknown.
   */
  readonly errorCode?: string;
  /**
   * The API's own client-facing message from the error response body, without
   * the SDK's wrapper text (class name, status line, JSON). Absent for a stream
   * `error` event and for a failure whose response carries no message. Safe to
   * show to an end user; prefer it to `message` when `status` is set.
   */
  readonly detail?: string;
}

/** The folded view of an in-flight (or finished) inference stream. */
export interface InferenceStreamState {
  readonly status: InferenceStreamStatus;
  /** Accumulated assistant text (concatenated content_delta chunks). */
  readonly text: string;
  /** Terminal error (status === 'error'). */
  readonly error?: InferenceStreamError;
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
    case 'reasoning_delta':
      // Reasoning is not part of the answer: it is never folded into `text`.
      return state;
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
