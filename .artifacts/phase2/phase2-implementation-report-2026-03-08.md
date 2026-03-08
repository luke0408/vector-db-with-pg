# Phase 2 Implementation Report — 2026-03-08

## Scope
Phase 2 implemented the backend mutation and indexing flow for the managed BM25 foundation:
- BM25 settings update API
- managed document create/update/delete APIs
- BM25 task queue logging support in the admin service
- chunked BM25 indexing execution API with SSE streaming output
- pure helper layer for task consolidation and delta calculation

## Files changed
- `/Users/SunKyuChoi/Projects/vector-db-with-pg/apps/server/src/admin/admin.service.ts`
- `/Users/SunKyuChoi/Projects/vector-db-with-pg/apps/server/src/admin/admin.controller.ts`
- `/Users/SunKyuChoi/Projects/vector-db-with-pg/apps/server/src/admin/admin.types.ts`
- `/Users/SunKyuChoi/Projects/vector-db-with-pg/apps/server/src/admin/admin-indexing.ts`
- `/Users/SunKyuChoi/Projects/vector-db-with-pg/apps/server/test/admin.spec.ts`
- `/Users/SunKyuChoi/Projects/vector-db-with-pg/apps/server/test/admin-indexing.spec.ts`
- `/Users/SunKyuChoi/Projects/vector-db-with-pg/.artifacts/phase2/progress-report.jsonl`
- `/Users/SunKyuChoi/Projects/vector-db-with-pg/.artifacts/phase2-roadmap-2026-03-08.md`

## Delivered endpoints
- `PATCH /api/admin/bm25/:language/settings`
- `GET /api/admin/bm25/:language/run?chunkSize=...` (SSE)
- `POST /api/admin/documents/:tableName`
- `PUT /api/admin/documents/:tableName/:id`
- `DELETE /api/admin/documents/:tableName/:id`

## Implementation details
### Admin service
- Added BM25 settings mutation with validation for `k1` and `b`.
- Added managed document mutation methods that:
  - resolve table metadata from `search_managed_tables`
  - compute `fts` and `textlen`
  - update data rows transactionally
  - append queue rows into `bm25tasks_{lang}`
- Added BM25 indexing loop that:
  - deletes completed tasks
  - claims pending tasks in chunks with `FOR UPDATE SKIP LOCKED`
  - consolidates multiple task rows for the same document into a net delta
  - applies length/token/idf updates transactionally
  - marks tasks complete and emits progress events

### Indexing helpers
- Added standalone helper module to parse `tsvector::text` and compute:
  - consolidated per-document queue deltas
  - length deltas
  - document-frequency deltas

### Controller
- Added parsers/validation for BM25 settings, document payloads, numeric IDs, vector arrays, and SSE chunk size.
- Added manual SSE response handling for the indexing endpoint.

## Validation
Passed:
- `npm run typecheck:server`
- `npm run test:server`
- `npm run build:server`

## Known limitations
- Runtime smoke validation against the live database has not yet been completed for the new mutation and SSE endpoints.
- The token table update path currently replaces per-document token rows after consolidation rather than applying raw tf deltas directly.
- Admin UI integration for these new endpoints is deferred to Phase 3.
