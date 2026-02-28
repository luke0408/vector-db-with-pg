# Hybrid Search Benchmark Report (HNSW vs IVFFlat)

## Summary

- Date: 2026-03-01
- Scope: `namuwiki_documents` hybrid query (`query = 'arm'`, `LIMIT 10`, `OFFSET 0`)
- Rows in table: `867,025`
- Goal: Compare before/after query latency while enabling real ANN index usage

## Environment

- DB: PostgreSQL (pgvector enabled, Docker container `pgvector`)
- Table: `namuwiki_documents`
- Relevant indexes at measurement time:
  - `idx_namuwiki_documents_search_vector` (GIN on `search_vector`)
  - `idx_namuwiki_documents_embedding_hnsw` (HNSW on `embedding vector_cosine_ops`)
  - `idx_namuwiki_documents_embedding_ivfflat_ip` (IVFFlat on `embedding vector_ip_ops`, `lists = 200`)

## Queries Measured

### Before (legacy full scan path)

- Pattern: `LOWER(title/content) LIKE '%arm%'` + weighted sort using `ts_rank_cd`
- Plan signature: `Parallel Seq Scan -> Sort -> Gather Merge -> Limit`

### After-HNSW (ANN path)

- Seed vector fetched from top lexical match (`search_vector @@ plainto_tsquery('simple', 'arm')`)
- ANN candidate retrieval with `ORDER BY embedding <=> :query_vector LIMIT 500`
- Plan signature: `Index Scan using idx_namuwiki_documents_embedding_hnsw`

### After-IVFFlat (ANN path)

- Same seed vector strategy
- ANN candidate retrieval with `ORDER BY embedding <#> :query_vector LIMIT 500`
- Plan signature: `Index Scan using idx_namuwiki_documents_embedding_ivfflat_ip`

## Result Comparison

| Mode | Execution Time (ms) | Main Plan Node |
| --- | ---: | --- |
| Before (legacy) | 70,750.377 | `Parallel Seq Scan` |
| After-HNSW | 334.207 | `Index Scan (HNSW)` |
| After-IVFFlat | 668.690 | `Index Scan (IVFFlat)` |

Derived improvement vs legacy:

- HNSW: ~211.7x faster
- IVFFlat: ~105.8x faster

## Raw Plan Highlights

- Before:
  - `Execution Time: 70750.377 ms`
  - `Parallel Seq Scan on namuwiki_documents`
- HNSW:
  - `Execution Time: 334.207 ms`
  - `Index Scan using idx_namuwiki_documents_embedding_hnsw`
- IVFFlat:
  - `Execution Time: 668.690 ms`
  - `Index Scan using idx_namuwiki_documents_embedding_ivfflat_ip`

## Reproduction Snippet

Run inside DB container:

```bash
docker exec -i pgvector psql -U luke -d luke -v ON_ERROR_STOP=1 -P pager=off <<'SQL'
SELECT embedding::text AS query_vector
FROM namuwiki_documents
WHERE search_vector @@ plainto_tsquery('simple', 'arm')
  AND embedding IS NOT NULL
ORDER BY ts_rank_cd(search_vector, plainto_tsquery('simple', 'arm')) DESC, id DESC
LIMIT 1
\gset

EXPLAIN (ANALYZE, BUFFERS)
WITH ann_candidates AS (
  SELECT id, embedding <=> :'query_vector'::vector AS vector_distance
  FROM namuwiki_documents
  WHERE embedding IS NOT NULL
  ORDER BY embedding <=> :'query_vector'::vector
  LIMIT 500
)
SELECT * FROM ann_candidates LIMIT 10;
SQL
```

## Notes

- ANN mode now uses actual vector distance operators, so `hnsw/ivf` are not UI-only flags anymore.
- Candidate pool and ANN runtime knobs (`hnsw.ef_search`, `ivfflat.probes`) can further shift latency/recall trade-offs.
