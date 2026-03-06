# Ingestion Dotenv and Connection Preflight Update (2026-03-03)

## 1) Background

Running `infra/db/scripts/ingest_namuwiki_qwen.py` failed with `psycopg.OperationalError` against `localhost:5432` while the local Docker Postgres was exposed on a non-default port. The scripts only loaded `infra/db/.env`, so root-level `.env` values used by Docker Compose were ignored.

Also, both ingestion scripts loaded embedding models before opening the database connection, causing unnecessary model initialization time when DB parameters were wrong.

## 2) Changed Files

- `infra/db/scripts/ingest_namuwiki.py`
- `infra/db/scripts/ingest_namuwiki_qwen.py`

## 3) Behavior Change Summary (User Impact)

- Both ingestion scripts now load dotenv values from:
  - `infra/db/.env` (primary, if present)
  - repository root `.env` (fallback)
- Both scripts now open the PostgreSQL connection before loading embedding models, so DB misconfiguration fails fast.
- Qwen ingestion updates `transformers` model loading to use `dtype=` instead of deprecated `torch_dtype=`.
- Qwen ingestion prefers `AutoModelForImageTextToText` (with fallback to `AutoModel`) and reads token embeddings from `hidden_states` when needed.
- `MAX_ROWS=0` now correctly processes zero rows (previously one row could still be processed due an off-by-one check order).

This improves startup reliability and reduces wasted warm-up time on configuration failures.

## 4) Verification Method

### Syntax verification

```bash
python3 -m py_compile infra/db/scripts/ingest_namuwiki.py infra/db/scripts/ingest_namuwiki_qwen.py
```

### Dotenv + DB connectivity smoke test

```bash
python3 - <<'PY'
from infra.db.scripts import ingest_namuwiki_qwen as q
import psycopg

q.load_dotenv(q.DB_ROOT_DIR / '.env')
q.load_dotenv(q.PROJECT_ROOT_DIR / '.env')
params = q.get_db_params()

with psycopg.connect(**params) as conn:
    with conn.cursor() as cur:
        cur.execute('SELECT 1')
        assert cur.fetchone()[0] == 1

print('db-check-ok', params['port'])
PY
```

### Qwen script smoke run (zero-row)

```bash
SKIP_INIT_SQL=false MAX_ROWS=0 python3 infra/db/scripts/ingest_namuwiki_qwen.py
```

Expected key outputs:
- Connection succeeds with configured DB parameters.
- `Done. Total Qwen upserted rows: 0`
- `Shard rows processed: 0/0`

### Baseline script smoke run (zero-row)

```bash
MAX_ROWS=0 python3 infra/db/scripts/ingest_namuwiki.py
```

Expected key output:
- `Done. Total upserted rows: 0`

## 5) Rollback / Safety

- Rollback path: revert changes in both ingestion scripts listed above.
- Safety: SQL schema/upsert logic is unchanged; this update only changes env loading order, connection timing, and model-loading/output extraction wiring.
