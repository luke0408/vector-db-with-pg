# Query Benchmarking (Two-Track)

The custom in-repo benchmark runner has been removed.

Use the two-track approach:

1. ANN algorithm benchmarking with ANN-Benchmarks
2. Operational query tuning with PostgreSQL telemetry

## Track 1: ANN-Benchmarks (pgvector)

Setup:

```bash
npm run benchmark:ann:setup
```

If `python3` points to an older interpreter, set override:

```bash
ANN_BENCHMARKS_PYTHON=python3.13 npm run benchmark:ann:setup
```

Run:

```bash
npm run benchmark:ann:run
```

Quick smoke run example:

```bash
ANN_DATASET=mnist-784-euclidean ANN_COUNT=1 ANN_RUNS=1 ANN_MAX_N_ALGORITHMS=1 npm run benchmark:ann:run
```

Artifacts and details:

- `infra/benchmark/ann-benchmarks/setup.sh`
- `infra/benchmark/ann-benchmarks/run.sh`
- `infra/benchmark/ann-benchmarks/README.md`

The ANN scripts patch local ANN-Benchmarks `runner.py` so `ANN_BENCHMARKS_PG_*` variables are passed into Docker containers. This ensures `ANN_BENCHMARKS_PG_START_SERVICE=false` is effective and avoids in-container PostgreSQL port collisions.
They also clean stale `ann-benchmarks-pgvector` containers by default before each run (`ANN_BENCHMARKS_CLEAN_STALE_CONTAINERS=true`), preventing lock contention from interrupted prior runs.
Before each run, stale ANN benchmark backends older than 5 minutes are also terminated by default (`ANN_BENCHMARKS_TERMINATE_STALE_BACKENDS=true`) to clear leftover `CREATE INDEX ON items ...` / `DROP TABLE IF EXISTS items` lock chains.

## Track 2: Operational Query Tuning

Generate a markdown tuning report from live DB stats:

```bash
npm run benchmark:ops:report
```

Artifacts and details:

- `infra/benchmark/ops-tuning/collect-report.sh`
- `infra/benchmark/ops-tuning/sql/*`
- `infra/benchmark/ops-tuning/README.md`

## DB Runtime Requirements

The compose setup preloads tuning extensions/config:

- `pg_stat_statements`
- `auto_explain`

And DB init enables extension:

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

Relevant files:

- `docker-compose.yml`
- `infra/db/docker-compose.yml`
- `infra/db/sql/init.sql`
