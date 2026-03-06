# Qwen Ingestion Progress Bar Update (2026-03-03)

## 1) Background

The Qwen ingestion script did not expose real-time progress while embedding and upserting rows. During long runs, it was hard to determine remaining work per shard.

## 2) Changed Files

- `infra/db/scripts/ingest_namuwiki_qwen.py`

## 3) Behavior Change Summary (User Impact)

- Added a shard-aware terminal progress bar during ingestion.
- Progress now shows processed/target rows and percentage for the current shard.
- Added optional environment variables:
  - `QWEN_PROGRESS_WIDTH` (default: `30`)
  - `QWEN_PROGRESS_EVERY` (default: `DB_COMMIT_ROWS`)
- Added startup and completion summary lines:
  - `Shard target rows: ...`
  - `Shard rows processed: current/target`

This improves observability without changing embedding or DB upsert semantics.

## 4) Verification Method

### Syntax verification

```bash
python3 -m py_compile infra/db/scripts/ingest_namuwiki_qwen.py
```

### Helper logic smoke test

```bash
python3 - <<'PY'
from infra.db.scripts.ingest_namuwiki_qwen import estimate_shard_total_rows

assert estimate_shard_total_rows(10, 0, 4) == 3
assert estimate_shard_total_rows(10, 1, 4) == 3
assert estimate_shard_total_rows(10, 2, 4) == 2
assert estimate_shard_total_rows(10, 3, 4) == 2
assert estimate_shard_total_rows(0, 0, 1) == 0

print("progress-helpers-ok")
PY
```

## 5) Rollback / Safety

- Rollback path: revert `infra/db/scripts/ingest_namuwiki_qwen.py`.
- Safety: progress rendering is output-only and does not modify ingestion data flow, embedding values, or SQL upsert logic.
