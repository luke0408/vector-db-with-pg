# Phase 3 Implementation Report — 2026-03-08

## Scope
Phase 3 expanded the web admin surface so the Phase 2 backend can be operated from the UI.

## Files changed
- `/Users/SunKyuChoi/Projects/vector-db-with-pg/apps/web/src/App.tsx`
- `/Users/SunKyuChoi/Projects/vector-db-with-pg/apps/web/src/App.test.tsx`
- `/Users/SunKyuChoi/Projects/vector-db-with-pg/apps/web/src/lib/search-api.ts`
- `/Users/SunKyuChoi/Projects/vector-db-with-pg/apps/web/src/styles.css`

## Delivered admin UI capabilities
- BM25 settings editor (`k1`, `b`) per selected language
- chunk size input with per-language `localStorage` persistence
- Run Indexing button wired to the Phase 2 SSE endpoint
- Cancel button backed by `AbortController`
- in-page indexing progress log that renders streamed chunk events

## Implementation details
### search-api
- Added `updateBm25Settings(language, payload)`
- Added `runBm25IndexingStream(language, { chunkSize, onEvent, signal })`
- Implemented a small SSE text-stream parser on top of `fetch()` so the UI can consume server-side event chunks without introducing a new dependency.

### App
- Added BM25 settings draft state that is kept in sync with the selected language status.
- Added chunk-size persistence helpers that safely degrade when `localStorage` is not available.
- Added indexing run/cancel flow and progress event rendering.

### Tests
- Added UI tests covering:
  - BM25 settings save flow
  - indexing launch flow
  - per-language chunk size persistence

## Validation
Passed:
- `npm run typecheck:web`
- `npm run test:web`
- `npm run build:web`

## Known limitations
- The search screen still uses the legacy search contract and does not yet use managed-table selection.
- Admin document mutation flows are not yet exposed in the web UI.
- Runtime browser smoke validation against the live server is still pending.
