// ---------------------------------------------------------------------------
// Barrel exports for the inference module — streaming SSE state for chat/RAG/
// document-ask surfaces. See inferenceStream.ts's header for the shape.
// ---------------------------------------------------------------------------

export {
  INITIAL_INFERENCE_STREAM_STATE,
  startedInferenceStreamState,
  reduceInferenceEvent,
} from './inferenceStream';
export type {
  InferenceStreamEvent,
  InferenceStreamStatus,
  InferenceStreamState,
  TruncationWarning,
} from './inferenceStream';

export { useInferenceStream } from './useInferenceStream';
export type { UseInferenceStream, InferenceStreamRunner } from './useInferenceStream';
