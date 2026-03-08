# Phase 1 Implementation Report

- Date: 2026-03-08 (Asia/Seoul)
- Scope: managed-search foundation only
- Status: implemented in code; validated with unit/web tests and builds

## Implemented

### Backend
- Added admin module skeleton under `apps/server/src/admin/`
- Added localhost-only admin guard
- Added Phase 1 admin endpoints:
  - `GET /api/admin/languages`
  - `GET /api/admin/tables`
  - `GET /api/admin/bm25/:language/status`
  - `POST /api/admin/tables/register-existing`
- Added bootstrap logic for:
  - `global_id_seq`
  - `search_supported_languages`
  - `search_bm25_language_settings`
  - `search_managed_tables`
  - `bm25_tsvector_token_stats(...)`
  - per-language support tables for every `pg_ts_config`
- Added `namuwiki_documents` Phase 1 preparation support:
  - `textlen`
  - `fts`
  - `embedding_qwen`
  - `embedding_hnsw`
  - default ID sequence migration to `global_id_seq`
- Added register-existing/backfill path that:
  - ensures required columns exist
  - populates `fts` and `textlen`
  - copies Qwen embeddings into `embedding_qwen` / `embedding_hnsw` for `namuwiki_documents`
  - rebuilds BM25 snapshot tables for the selected language

### SQL bootstrap
- Expanded `infra/db/sql/init.sql` to include Phase 1 foundation objects

### Web
- Added minimal admin workspace in `apps/web`
- Added API helpers for admin endpoints
- Added read-only language/table overview and BM25 status display
- Added one-click `Register NamuWiki Table` action for Phase 1 initialization

## Explicitly not implemented yet
- online CUD task logging
- SSE indexing loop / cancel
- net-delta consolidation worker
- search API cutover to support-table BM25
- `embeddingModel` removal from search UI/API

## Validation
- `npm run typecheck:server` ✅
- `npm run test:server` ✅
- `npm run test:web` ✅
- `npm run build` ✅

## Runtime note
- Live admin endpoint smoke test against local DB was not completed because Prisma could not connect to the configured database endpoint (`localhost:5517`) during this session.
