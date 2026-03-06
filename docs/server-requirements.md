# Nest Server Requirements for Vector Search Learning and Benchmarking (v1 Focus)

## 1) Objective

- Build a NestJS service for pgvector learning, search experimentation, and benchmark preparation on top of PostgreSQL + pgvector.
- Reuse `namuwiki_documents` schema from `infra/db/sql/init.sql`.
- Keep docker-compose as the primary local runtime.
- In v1, prioritize learning visibility features from web UI: `Generated SQL`, `Query Execution Plan`, and `Query Explanation`.

## 2) Scope and Version Policy

- This document is **v1/v1.5 only**. v2 is out of scope.
- Endpoint naming is unified to `/api/*`.
- Health endpoint must be `GET /api/health`.
- `POST /api/search` response `data` must always be an array.
- Pagination baseline in v1 is **offset-based**.

## 3) Functional Requirements

### MUST (v1)

- `FR-1`: Provide `POST /api/search` for vector-oriented search with top-k and offset pagination.
- `FR-2`: Provide learning visibility fields for search:
  - generated SQL string
  - execution plan (JSON)
  - query explanation (human-readable summary)
- `FR-3`: Support metadata filtering baseline (title keyword required, namespace/contributor optional in v1.5).
- `FR-4`: `GET /api/health` must check readiness/liveness including DB connectivity.

### SHOULD (v1.5)

- `FR-5`: Provide `POST /api/search/hybrid` combining vector similarity and PostgreSQL full-text (`search_vector`).
- `FR-6`: Support request options that match current web controls:
  - search mode (`none`, `hnsw`, `ivf`)
  - BM25 toggle
  - hybrid ratio

### LATER (post-v1.5)

- `FR-7`: Benchmark execution endpoint and run-summary endpoint.
- `FR-8`: Ingestion orchestration endpoint for embedding job metadata.
- `FR-9`: Index management endpoints (HNSW, IVFFlat) in non-production mode.
- `FR-10`: Experiment profile store/replay endpoint.

## 4) API Requirements

### 4.1 Required Endpoints (v1/v1.5)

- `POST /api/search`
- `GET /api/health`
- `POST /api/search/hybrid` (v1.5)

### 4.2 Deferred Endpoints (LATER)

- `POST /api/benchmark/run`
- `GET /api/benchmark/:runId`
- `POST /api/ingest/jobs`
- `POST /api/indexes/*`
- `POST /api/experiments/*`

### 4.3 Response Envelope Policy (v1 fixed)

```ts
interface ApiResponse<T> {
  success: boolean
  data: T[]
  error?: string
  meta?: {
    total: number
    offset: number
    limit: number
    tookMs?: number
    requestId?: string
    embeddingModelUsed?: 'base' | 'qwen3' // hybrid endpoint only
  }
}
```

- `data` is always present and always an array, even on empty results.

### 4.4 `POST /api/search` Contract (v1 fixed)

Request:

```ts
interface SearchRequestV1 {
  query: string
  offset?: number
  limit?: number
}
```

Response item:

```ts
interface SearchResultV1 {
  id: number
  title: string
  snippet: string
  score: number
  // Optional learning fields for current web rendering compatibility
  category?: string
  distance?: number
  tags?: string[]
  matchRate?: number
}
```

Response data shape:

```ts
interface SearchResponseV1Data {
  items: SearchResultV1[]
  learning: {
    generatedSql: string
    executionPlan: Record<string, unknown>
    queryExplanation: string
  }
}
```

Note: To keep `data` always as array under global policy, `POST /api/search` returns:

```ts
ApiResponse<SearchResponseV1Data>
```

with one element in `data` containing `items` + `learning`.

### 4.5 `POST /api/search/hybrid` Contract (v1.5)

Request:

```ts
interface SearchHybridRequestV15 {
  query: string
  offset?: number
  limit?: number
  mode?: 'none' | 'hnsw' | 'ivf'
  bm25Enabled?: boolean
  hybridRatio?: number // 0..100
  embeddingModel?: 'base' | 'qwen3' // default: 'base'
}
```

Response follows same envelope and learning fields policy as `POST /api/search`.

## 5) Data and Index Requirements

- Preserve compatibility with dual embedding shapes:
  - `base` => `namuwiki_documents.embedding` (`VECTOR(384)`)
  - `qwen3` => `namuwiki_document_embeddings_qwen.embedding` (`VECTOR(1024)`)
- Validate request `embeddingModel` enum at API boundary before DB execution.
- Keep text search config fallback (`korean` -> `simple`) aligned with DB init.
- In v1, index strategy APIs are deferred, but query plan output must expose whether index scan or sequential scan is used for learning.

## 6) Non-Functional Requirements

- `NFR-1`: p95 latency under 300ms for top-10 baseline search in local profile.
- `NFR-2`: p99 latency under 500ms for hybrid search baseline (v1.5).
- `NFR-3`: Throughput target >= 50 RPS under mixed read workload.
- `NFR-4`: Schema validation for all external request payloads.
- `NFR-5`: Structured logs with request ID and correlation IDs.
- `NFR-6`: No hardcoded secrets; environment-only resolution.

## 7) Evaluation Requirements

- Accuracy metrics: Recall@K, MRR, nDCG.
- Performance metrics: p50/p95/p99 latency, RPS, error rate.
- Reproducibility:
  - benchmark profile captures dataset slice, model, index type, query set, parameters.
  - benchmark run replayable in docker-compose.

## 8) Security and Reliability Requirements

- Parameterized SQL only; no unsafe string interpolation.
- Separate rate limits for search endpoints and benchmark endpoints.
- Production error responses must not expose SQL, credentials, stack traces.
- Idempotency key required for benchmark run creation (LATER scope).
- Learning visibility fields (`generatedSql`, `executionPlan`, `queryExplanation`) must support environment-based exposure control (dev/restricted modes).

## 9) Docker-Compose Alignment Requirements

- Service connectivity defaults:
  - server -> `pgvector:5432` inside compose network.
  - web -> `server:3000` inside compose network; browser access via host port.
- Health checks for server and pgvector required before benchmark jobs start.
- One-command local bring-up must remain: `docker compose up -d --build`.

## 10) Acceptance Criteria (Measurable)

- `AC-1` (v1): web + server + pgvector run in docker-compose; `POST /api/search` succeeds end-to-end.
- `AC-2` (v1): `GET /api/health` returns app+DB readiness.
- `AC-3` (v1): search response includes learning fields:
  - generated SQL
  - execution plan
  - query explanation
- `AC-4` (v1): `data` field is always an array and offset pagination works.
- `AC-5` (v1.5): `/api/search/hybrid` supports mode/BM25/hybrid ratio.
- `AC-6` (v1.5): `/api/search/hybrid` supports `embeddingModel` (`base`/`qwen3`) and returns `meta.embeddingModelUsed`.

## 11) Current Code Baseline Notes

- Current endpoints in code: `POST /api/search`, `GET /api/health`, `POST /api/search/hybrid`.
- Current web API client contract: `{ query }` request, `{ success, data?, error? }` response.
- Current web UI contains visible learning panels (`Generated SQL`, `Query Execution Plan`, `Scoring Breakdown`) and expects to surface explainability artifacts.

## 12) TODO (Implementation Checklist)

### Phase 0 - Contract Freeze (MUST)

- [ ] Update server health path to `GET /api/health`.
- [ ] Enforce `ApiResponse<T>` policy with `data` always array.
- [ ] Add offset pagination params (`offset`, `limit`) and response `meta`.
- [ ] Define score semantics and document `distance`/`matchRate` usage.

### Phase 1 - Core Search + Learning Visibility (MUST)

- [ ] Return `generatedSql` in search response.
- [ ] Return execution plan JSON (`EXPLAIN ... FORMAT JSON`) in search response.
- [ ] Return `queryExplanation` summary in search response.
- [ ] Add validation and error policy coverage tests.

### Phase 1.5 - Hybrid Controls (SHOULD)

- [x] Implement `POST /api/search/hybrid`.
- [x] Wire mode/BM25/hybrid ratio request options.
- [x] Validate hybrid ratio bounds and fallback behavior.
- [x] Add `embeddingModel` request option (`base`/`qwen3`, default `base`).
- [x] Return `meta.embeddingModelUsed` in hybrid search response.

### Phase 2 - Benchmark/Index/Experiment (LATER)

- [ ] Implement benchmark run/result endpoints.
- [ ] Implement ingest job metadata endpoint.
- [ ] Implement non-production index management endpoints.
- [ ] Implement experiment profile persistence/replay.

### Quality and Security Gates

- [ ] Add structured request/benchmark correlation logging.
- [ ] Add rate limiting by endpoint class.
- [ ] Gate learning debug fields by environment policy.
- [ ] Add regression tests (unit + integration) for search and orchestration flows.
