# ANN-Benchmarks Track

This track runs pgvector against ANN-Benchmarks for recall/latency/QPS comparisons.

Python requirement: 3.10+.

## 1) Setup

```bash
npm run benchmark:ann:setup
```

This clones/updates `erikbern/ann-benchmarks`, installs Python deps, and builds the pgvector benchmark image.

The setup script auto-selects a Python interpreter in this order:
`python3.13`, `python3.12`, `python3.11`, `python3.10`, `python3`.

If you want to force a specific interpreter:

```bash
ANN_BENCHMARKS_PYTHON=python3.13 npm run benchmark:ann:setup
```

Dependencies are installed into `${ANN_BENCHMARKS_DIR}/.venv`.

## 2) Run benchmark

```bash
npm run benchmark:ann:run
```

### Common environment overrides

- `ANN_DATASET` (default: `glove-100-angular`)
- `ANN_COUNT` (default: `10`)
- `ANN_RUNS` (default: `5`)
- `ANN_PARALLELISM` (default: `1`)
- `ANN_MAX_N_ALGORITHMS` (optional, useful for smoke runs)
- `ANN_BENCHMARKS_DIR` (default: `$HOME/.cache/ann-benchmarks`)
- `ANN_BENCHMARKS_PYTHON` (optional interpreter override)
- `ANN_BENCHMARKS_CLEAN_STALE_CONTAINERS` (default: `true`)
- `ANN_BENCHMARKS_TERMINATE_STALE_BACKENDS` (default: `true`)
- `ANN_BENCHMARKS_STALE_BACKEND_MIN_AGE_SECONDS` (default: `300`)

### PostgreSQL connection overrides

- `ANN_BENCHMARKS_PG_HOST`
- `ANN_BENCHMARKS_PG_PORT`
- `ANN_BENCHMARKS_PG_USER`
- `ANN_BENCHMARKS_PG_PASSWORD`
- `ANN_BENCHMARKS_PG_DBNAME`
- `ANN_BENCHMARKS_PG_START_SERVICE` (default from script: `false`)

By default, the runner uses `host.docker.internal:5432` so ANN-Benchmarks Docker containers can connect to a locally running Postgres.
If present, repository `.env` values (`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_PORT`) are used as fallback defaults.

The setup/run scripts patch ANN-Benchmarks' local `runner.py` to forward `ANN_BENCHMARKS_PG_*` environment variables into benchmark containers. This is required so `ANN_BENCHMARKS_PG_START_SERVICE=false` is respected and does not conflict with an already-running Postgres on port `5432`.
The run script also cleans stale `ann-benchmarks-pgvector` containers before execution by default, which avoids lock waits such as `DROP TABLE IF EXISTS items` stalling behind previous interrupted runs.
It also terminates old benchmark backend queries (for `CREATE INDEX ON items ...` / `DROP TABLE IF EXISTS items`) that can survive interrupted runs and keep relation locks.

## Notes

- Keep DB and host load low during runs for reproducibility.
- Compare results with fixed dataset/count/runs/parallelism.
- For deeper comparisons, use ANN-Benchmarks native options directly in its repo.
