# Phase 4 Implementation Report — 2026-03-08

## Scope
Phase 4 performed the managed-search cutover for the existing search flow.

## Files changed
- `/Users/SunKyuChoi/Projects/vector-db-with-pg/apps/server/src/app.service.ts`
- `/Users/SunKyuChoi/Projects/vector-db-with-pg/apps/server/src/app.controller.ts`
- `/Users/SunKyuChoi/Projects/vector-db-with-pg/apps/server/src/types/search-contract.ts`
- `/Users/SunKyuChoi/Projects/vector-db-with-pg/apps/server/test/app.spec.ts`
- `/Users/SunKyuChoi/Projects/vector-db-with-pg/apps/web/src/App.tsx`
- `/Users/SunKyuChoi/Projects/vector-db-with-pg/apps/web/src/App.test.tsx`
- `/Users/SunKyuChoi/Projects/vector-db-with-pg/apps/web/src/lib/search-api.ts`
- `/Users/SunKyuChoi/Projects/vector-db-with-pg/apps/web/src/styles.css`

## Delivered functionality
- Search requests now accept optional `tableName` and route through managed-table metadata.
- Search UI now lets the user choose a managed table instead of toggling embedding model variants.
- Default query embedding path is now Qwen3 in the request/UI layer.
- Hybrid search reads BM25 support tables (`bm25length_*`, `bm25tokens_*`, `bm25idf_*`) to compute lexical scores for managed search ranking and fallback.
- Hybrid search can use the managed `embedding_hnsw` column, with a legacy join fallback for `namuwiki_documents` against `namuwiki_document_embeddings_qwen`.

## Implementation details
### Server
- Added managed search context resolution with metadata-driven table/column/language selection.
- Reworked lexical search to use managed table columns and generated/default FTS expressions.
- Reworked hybrid search to:
  - use managed embeddings
  - compute BM25 with managed support tables
  - preserve ANN candidate-pool tuning and fallback heuristics
- Added request/meta support for `tableName`.

### Web
- Removed the search-screen embedding-model toggle.
- Added managed-table selection to the search controls.
- Defaulted the client search path to Qwen3 while keeping API compatibility.

## Validation
Passed:
- `npm run test:server`
- `npm run test:web`
- `npm run typecheck`
- `npm run build`

## Known limitations
- The backend still accepts `embeddingModel` for compatibility, even though the UI is now Qwen3-first.
- Non-`namuwiki_documents` managed tables currently fall back to generic category/tags instead of domain-specific metadata fields.
- Live smoke validation against a fully initialized managed-table dataset is still pending.
