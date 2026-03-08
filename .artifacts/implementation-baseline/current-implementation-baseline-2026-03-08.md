# Current Implementation Baseline Report

- Generated at: 2026-03-08 (Asia/Seoul)
- Baseline HEAD: `c665ae28eb576ad28a66f45923f22370a22c971f`
- Purpose: leave a fixed snapshot of the **current repo implementation** before the managed multi-table / BM25 support-table redesign begins.

## 1. Executive Summary

The current repository is a **NamuWiki-specific search system** built on top of PostgreSQL text search and pgvector, with a thin React UI and a NestJS server.

It is **not** yet a generic search platform.

Current shape:
- One primary content table: `namuwiki_documents`
- One auxiliary Qwen embedding table: `namuwiki_document_embeddings_qwen`
- Search APIs: lexical search and hybrid ANN search
- UI: search screen only
- No admin module, no managed table registry, no BM25 support tables, no task queue, no SSE indexing control
- Query embedding is handled by a long-lived Python worker process with optional prewarm

This baseline should be compared against the future target design in the following dimensions:
- single-table vs managed multi-table
- runtime `ts_rank_cd` scoring vs materialized BM25 support tables
- static search UI vs search + admin UI
- offline ingest scripts vs API-driven CUD/task logging
- no indexing control plane vs SSE chunked indexing control plane

## 2. Current System Architecture

### 2.1 Server architecture

Current backend is a NestJS app under `/Users/SunKyuChoi/Projects/vector-db-with-pg/apps/server`.

Primary public routes:
- `GET /api/health`
- `POST /api/search`
- `POST /api/search/hybrid`

Relevant code:
- `/Users/SunKyuChoi/Projects/vector-db-with-pg/apps/server/src/app.controller.ts`
- `/Users/SunKyuChoi/Projects/vector-db-with-pg/apps/server/src/app.service.ts`
- `/Users/SunKyuChoi/Projects/vector-db-with-pg/apps/server/src/query-embedding.service.ts`

There are **no** admin routes for:
- table creation/registration
- BM25 language management
- indexing queue inspection
- CUD ingest management
- SSE progress streaming

### 2.2 Search flow

#### A. Lexical search

`AppService.search()` currently performs:
- lowercased LIKE search on title/content
- simple score heuristic for title/content match
- total count query
- execution plan collection (unless `SEARCH_INCLUDE_EXPLAIN=false`)

This path is optimized for debugging and fallback, not for generic managed-table search.

#### B. Hybrid search

`AppService.searchHybrid()` currently performs:
1. query normalization and keyword extraction
2. query embedding generation through `QueryEmbeddingService`
3. ANN candidate search using pgvector HNSW or IVF
4. candidate-level BM25-like reranking via `ts_rank_cd(..., plainto_tsquery(...))`
5. weighted ensemble of vector score and BM25 score
6. fallback to lexical BM25-like search when:
   - embeddings are unavailable
   - ANN candidate set is empty
   - ANN signal is considered weak
   - ANN query fails

This is still an **application-level hybrid search**, not the proposed language-specific support-table BM25 architecture.

### 2.3 Query embedding service

`QueryEmbeddingService` currently provides:
- persistent Python helper workers per embedding model
- in-memory exact-query cache
- prewarm support via `QUERY_EMBED_PREWARM_MODELS`
- health reporting of configured/ready/pending models
- worker ready handshake through `/Users/SunKyuChoi/Projects/vector-db-with-pg/infra/db/scripts/embed_query.py`

Important note:
- the major observed latency bottleneck is still **query embedding generation** (`seedLookupMs`), not ANN SQL execution.

## 3. Current Database / Schema Baseline

Schema initialization is currently driven by:
- `/Users/SunKyuChoi/Projects/vector-db-with-pg/infra/db/sql/init.sql`

Current extensions:
- `vector`
- `pg_stat_statements`
- `textsearch_ko`

Current main objects:

### 3.1 `namuwiki_documents`
Columns:
- `id BIGSERIAL PRIMARY KEY`
- `doc_hash TEXT UNIQUE`
- `title TEXT`
- `content TEXT`
- `contributors TEXT`
- `namespace TEXT`
- `search_vector TSVECTOR`
- `embedding VECTOR(384)`
- timestamps

Indexes:
- GIN on `search_vector`
- HNSW on `embedding vector_cosine_ops`
- IVFFlat on `embedding vector_ip_ops`

### 3.2 `namuwiki_document_embeddings_qwen`
Columns:
- `doc_hash TEXT PRIMARY KEY REFERENCES namuwiki_documents(doc_hash)`
- `embedding VECTOR(1024)`
- `updated_at`

Indexes:
- HNSW on `embedding vector_cosine_ops`
- IVFFlat on `embedding vector_ip_ops`

### 3.3 What is **not** present yet

The current schema does **not** have:
- `global_id_seq`
- managed table registry metadata
- BM25 settings metadata per language
- `bm25length_{lang}` tables
- `bm25tokens_{lang}` tables
- `bm25idf_{lang}` tables
- `bm25tasks_{lang}` tables
- generic table configuration records
- task-claim / status lifecycle infrastructure

## 4. Current Ingestion / Update Model

Relevant scripts:
- `/Users/SunKyuChoi/Projects/vector-db-with-pg/infra/db/scripts/ingest_namuwiki.py`
- `/Users/SunKyuChoi/Projects/vector-db-with-pg/infra/db/scripts/ingest_namuwiki_qwen.py`

Current ingestion characteristics:
- batch-oriented Python scripts
- directly upsert NamuWiki data into fixed tables
- compute `to_tsvector` during ingestion
- compute embeddings offline during ingestion
- no task queue for INSERT/UPDATE/DELETE net-delta processing
- no API-driven CUD path for managed documents
- no per-language BM25 table maintenance

In other words, current ingestion is **bulk-load oriented**, not a general-purpose online indexing pipeline.

## 5. Current Web/UI Baseline

Current frontend lives in `/Users/SunKyuChoi/Projects/vector-db-with-pg/apps/web`.

Current UI capabilities:
- query input
- search mode toggle (`none`, `hnsw`, `ivf`)
- BM25 enable toggle
- hybrid ratio slider
- embedding model toggle (`base`, `qwen3`)
- generated SQL panel
- execution plan panel
- explanation panel

Current UI does **not** include:
- admin dashboard
- managed table creation/registration
- FTS language selector driven by `pg_ts_config`
- BM25 language cards
- chunk size persistence by language
- SSE indexing progress/cancel UI
- per-table vector config editor

## 6. Current API / Type Baseline

Current public request model (`/Users/SunKyuChoi/Projects/vector-db-with-pg/apps/server/src/types/search-contract.ts`):
- `query`
- `offset`
- `limit`
- `embeddingModel?: 'base' | 'qwen3'`
- hybrid only: `mode`, `bm25Enabled`, `hybridRatio`

Current response meta includes:
- `total`
- `offset`
- `limit`
- `tookMs`
- `embeddingModelUsed`

What is missing relative to the planned design:
- `tableName`
- `languageUsed`
- managed-table identifiers/configs
- BM25 admin settings API
- document ingest/update/delete admin API
- SSE event model for indexing

## 7. Current Search Logic Details (Implementation Snapshot)

Relevant functions in `/Users/SunKyuChoi/Projects/vector-db-with-pg/apps/server/src/app.service.ts`:
- `search()`
- `searchHybrid()`
- `searchHybridLexicalFallback()`
- `buildBm25QueryText()`
- `resolveCandidatePool()`
- `shouldFallbackFromWeakAnn()`

### 7.1 Hybrid ranking model

Current hybrid rank is based on:
- vector distance transformed into a unit interval score
- `ts_rank_cd`-derived keyword score transformed into a unit interval score
- weighted combination using `hybridRatio`

This is **not** the planned true BM25 support-table ranking model.

### 7.2 Candidate pool heuristics

Current implementation has adaptive ANN pool sizing:
- short queries: multiplier 12
- default queries: multiplier 9
- long natural language queries: multiplier 6
- max candidate pool: 120

### 7.3 Fallback heuristics

Current fallback is heuristic and app-level:
- no embedding store → lexical fallback
- no query vector → lexical fallback
- empty ANN candidates → lexical fallback
- weak ANN signal for long natural language queries → lexical fallback

This is **not** equivalent to the future BM25 task-backed indexing/search design.

## 8. Current Operational / Benchmark Baseline

Recent search latency artifacts:
- `/Users/SunKyuChoi/Projects/vector-db-with-pg/.artifacts/search-latency/search-latency-2026-03-08T07-21-29-063Z.json`
- `/Users/SunKyuChoi/Projects/vector-db-with-pg/.artifacts/search-latency/search-latency-2026-03-08T07-23-36-594Z.json`
- `/Users/SunKyuChoi/Projects/vector-db-with-pg/.artifacts/search-latency/search-latency-2026-03-08T07-26-29-339Z.json`
- `/Users/SunKyuChoi/Projects/vector-db-with-pg/.artifacts/search-latency/search-latency-2026-03-08T07-26-47-279Z.json`
- `/Users/SunKyuChoi/Projects/vector-db-with-pg/.artifacts/search-latency/search-latency-2026-03-08T07-27-15-124Z.json`

### 8.1 Key measured modes

#### Mode A — current/debug-like server
- server: `http://127.0.0.1:3000`
- summary: p50 `894ms`, p95 `47345ms`

#### Mode B — explain off, no prewarm
- server: `http://127.0.0.1:3001`
- summary: p50 `612ms`, p95 `77131ms`

#### Mode C — explain off + prewarm on, first-pass
- server: `http://127.0.0.1:3002`
- summary: p50 `598ms`, p95 `8774ms`

#### Mode D — warm-model + no exact-query-cache (most realistic steady-state baseline)
- artifact: `search-latency-2026-03-08T07-27-15-124Z.json`
- summary: p50 `278ms`, p95 `521ms`

### 8.2 What the benchmark means

Observed bottleneck hierarchy:
1. `seedLookupMs` (query embedding generation)
2. ANN query execution
3. result assembly

Interpretation:
- warm runtime latency is already fairly good
- cold start / first-inference latency is still significant
- SQL/ANN tuning helps, but **query embedding remains the dominant latency source**

### 8.3 Current retrieval quality snapshot

Recent benchmark outputs still show clear quality issues, for example:
- `포켓몬 마스터` → top result `1000만 볼트`
- `가장 좋은 프로그래밍 언어` → top result `Bbuing`
- `김승민 래퍼 설명` → top result `Adam Lambert`

So the current baseline should be treated as:
- **latency partially improved**
- **retrieval quality still unstable**

## 9. Gap vs Planned Redesign

The future design intends to add all of the following, which are absent today:

### 9.1 Data model / indexing plane
- managed multi-table registry
- global ID sequence across managed tables
- precreated BM25 support tables for every `pg_ts_config`
- per-language BM25 settings (`k1`, `b`)
- online CUD task queue with delta consolidation

### 9.2 Control plane / admin
- admin module and admin routes
- table creation and existing table registration
- BM25 status management per language
- chunk-based SSE indexing with cancel support

### 9.3 Search plane
- dynamic BM25 computed from support tables
- per-table language and vector settings
- managed-table-based routing
- deprecation of current `embeddingModel: base | qwen3` toggle in favor of table config

### 9.4 UI plane
- separate admin UI/module
- language cards
- chunk size localStorage by language
- indexing progress / cancel controls
- table config forms

## 10. Recommended Comparison Axes for Future Before/After Review

When the redesign is implemented, compare against this report on these axes:

1. **Schema complexity**
   - fixed NamuWiki tables only vs managed tables + BM25 support infra
2. **Operational model**
   - bulk ingest scripts only vs online CUD queue/indexing plane
3. **Search API model**
   - single-domain search vs managed-table search
4. **Ranking method**
   - runtime `ts_rank_cd` heuristic vs support-table BM25
5. **Latency profile**
   - query embedding dominated vs new BM25/runtime mix
6. **Quality profile**
   - current misrank examples vs redesigned retrieval quality
7. **UI scope**
   - search-only UI vs search + admin UI
8. **Risk profile**
   - simple runtime model vs queue/metadata/indexing control complexity

## 11. Bottom-Line Baseline Statement

As of this report, the repository is best described as:

> A NamuWiki-specific NestJS + React + PostgreSQL/pgvector search app with fixed schema, runtime ANN + FTS hybrid ranking, persistent query-embedding workers, and benchmark tooling — but without managed tables, BM25 support-table infrastructure, admin indexing controls, or online CUD net-delta indexing.

That is the exact baseline to compare against once the new managed multi-table BM25 platform implementation starts.
