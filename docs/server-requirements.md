# Nest Server Requirements for Vector Search Learning and Benchmarking

## 1) Objective

- Build a NestJS service that supports vector search learning, experimentation, and performance evaluation on top of PostgreSQL + pgvector.
- Reuse existing `namuwiki_documents` schema from `sql/init.sql` and keep docker-compose as the primary local execution environment.

## 2) Functional Requirements

- `FR-1`: Provide document search endpoint with vector similarity (`cosine`, `l2`, `inner product`) and top-k.
- `FR-2`: Provide hybrid retrieval endpoint combining vector similarity with PostgreSQL full-text matching on `search_vector`.
- `FR-3`: Provide metadata filtering (namespace, contributor, title keyword) and pagination for all search endpoints.
- `FR-4`: Provide benchmark execution endpoint that runs predefined query sets and returns aggregate metrics.
- `FR-5`: Provide ingestion orchestration endpoint to trigger/observe embedding generation jobs without replacing existing Python pipeline.
- `FR-6`: Provide index management endpoint set for creating and inspecting pgvector indexes (HNSW, IVFFlat) in non-production mode.
- `FR-7`: Provide experiment profile endpoint to store and replay benchmark parameters.

## 3) API Requirements

- `POST /api/search`: vector-only search.
- `POST /api/search/hybrid`: vector + full-text hybrid search.
- `POST /api/benchmark/run`: execute benchmark scenarios.
- `GET /api/benchmark/:runId`: fetch benchmark result summary.
- `POST /api/ingest/jobs`: create ingestion/embedding job metadata.
- `GET /api/health`: readiness/liveness check including DB connectivity.

All responses should follow the existing API response pattern:

```ts
interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
  meta?: {
    total: number
    page: number
    limit: number
  }
}
```

## 4) Data and Index Requirements

- Preserve compatibility with `VECTOR(384)` embedding shape used by `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`.
- Validate embedding dimension at API boundary before DB query execution.
- Provide migration scripts for index strategy experiments:
  - HNSW for low-latency approximate retrieval.
  - IVFFlat for memory-aware workloads.
- Ensure text search config fallback (`korean` -> `simple`) remains consistent with current DB initialization behavior.

## 5) Non-Functional Requirements

- `NFR-1`: p95 search latency under 300ms for top-10 on local benchmark corpus (baseline profile).
- `NFR-2`: p99 search latency under 500ms for hybrid search in baseline profile.
- `NFR-3`: Throughput target at least 50 requests/sec under mixed read workload on local docker profile.
- `NFR-4`: Input validation using schema validators on all external request payloads.
- `NFR-5`: Structured logs with request ID and benchmark run ID correlation.
- `NFR-6`: No secrets hardcoded; environment-only secret resolution.

## 6) Evaluation Requirements

- Accuracy metrics:
  - Recall@K
  - MRR
  - nDCG
- Performance metrics:
  - p50/p95/p99 latency
  - Throughput (RPS)
  - Error rate
- Reproducibility requirements:
  - benchmark profile must capture dataset slice, model, index type, query set, and search parameters.
  - benchmark run must be replayable in docker-compose environment.

## 7) Security and Reliability Requirements

- Parameterized SQL only; no string interpolation in raw queries.
- Rate limit search endpoints and benchmark endpoints separately.
- Error responses must not expose SQL, credentials, or stack traces in production mode.
- Idempotency key support for benchmark runs to prevent accidental duplicate heavy jobs.

## 8) Docker-Compose Alignment Requirements

- Service connectivity defaults:
  - server -> `pgvector:5432` inside compose network.
  - web -> `server:3000` inside compose network; browser access via exposed host port.
- Health checks required for server and pgvector before benchmark jobs can start.
- Local workflow must remain one-command bring-up with `docker compose up -d --build`.

## 9) Acceptance Criteria

- A user can run web + server + pgvector via docker-compose and perform a successful vector search request end-to-end.
- Benchmark endpoint can execute at least one profile and return metrics with persisted run ID.
- Search outputs include similarity score and metadata fields needed for learning analysis.
- Regression tests cover unit + integration flows around search and benchmark orchestration.
