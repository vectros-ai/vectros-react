// ---------------------------------------------------------------------------
// @vectros-ai/react/public: anonymous reads of an app context's public records with a publishable app key, and two
// TanStack Query hooks over them.
//
// Its own entry, not part of `/core`: it is the one part of this package that loads @vectros-ai/sdk at runtime, so an
// app that never reads public records never bundles the SDK. Nothing here imports MUI, Emotion, react-dom or
// react-router, so a React Native app or a server renderer can use it.
// ---------------------------------------------------------------------------

export {
  createPublicClient,
  formatCoordinate,
  DEFAULT_PUBLIC_BASE_URL,
  PUBLIC_SERVER_SECRET_HEADER,
} from './public/publicClient';
export type {
  PublicClient,
  PublicClientOptions,
  PublicListOptions,
  PublicNear,
  PublicRange,
  PublicSet,
  PublicRecord,
  PublicRecordPage,
  PublicRequestOptions,
  PublicSearchOptions,
  PublicSearchPage,
} from './public/publicClient';
export { usePublicList, usePublicRecord, PUBLIC_QUERY_KEY } from './public/hooks';
