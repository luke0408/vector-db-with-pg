# Operational Query Tuning Track

This track focuses on real production-like query behavior in PostgreSQL.

## Prerequisites

- `pg_stat_statements` must be preloaded (`shared_preload_libraries`).
- `auto_explain` should be preloaded for slow-plan capture.
- Extension should exist in target DB:

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

## Generate a markdown report

```bash
npm run benchmark:ops:report
```

Connection is controlled by standard PostgreSQL env vars:

- `PGHOST`
- `PGPORT`
- `PGUSER`
- `PGPASSWORD`
- `PGDATABASE`

Output location defaults to `.artifacts/ops-tuning/*.md`.

## Included SQL probes

- `01_top_total_exec.sql`: top expensive queries
- `02_vector_query_hotspots.sql`: vector operator-heavy statements
- `03_index_usage.sql`: index scan and size visibility
- `04_db_health_snapshot.sql`: DB-level health counters
- `05_reset_pg_stat_statements.sql`: reset stats window

## Recommended loop

1. Reset stats window if needed.
2. Run workload for representative traffic.
3. Generate report and identify top offenders.
4. Inspect slow statements with `EXPLAIN (ANALYZE, BUFFERS)`.
5. Tune index/query settings (`hnsw.ef_search`, `ivfflat.probes`, filtering strategy), then repeat.
