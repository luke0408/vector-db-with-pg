#!/usr/bin/env bash
set -euo pipefail

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-postgres}"
PGDATABASE="${PGDATABASE:-postgres}"

OUT_DIR="${OPS_REPORT_DIR:-.artifacts/ops-tuning}"
OUT_FILE="${OUT_DIR}/ops-report-$(date +%Y%m%d-%H%M%S).md"

mkdir -p "${OUT_DIR}"

psql_base=(
  psql
  "host=${PGHOST}"
  "port=${PGPORT}"
  "user=${PGUSER}"
  "dbname=${PGDATABASE}"
  -X
  -v
  ON_ERROR_STOP=1
)

{
  printf '# PostgreSQL Ops Tuning Report\n\n'
  printf '- Generated At: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '- Host: %s\n' "${PGHOST}"
  printf '- Port: %s\n' "${PGPORT}"
  printf '- Database: %s\n\n' "${PGDATABASE}"

  printf '## Top Queries by Total Exec Time\n\n'
  printf '```text\n'
  "${psql_base[@]}" -f "infra/benchmark/ops-tuning/sql/01_top_total_exec.sql"
  printf '```\n\n'

  printf '## Vector Query Hotspots\n\n'
  printf '```text\n'
  "${psql_base[@]}" -f "infra/benchmark/ops-tuning/sql/02_vector_query_hotspots.sql"
  printf '```\n\n'

  printf '## Index Usage\n\n'
  printf '```text\n'
  "${psql_base[@]}" -f "infra/benchmark/ops-tuning/sql/03_index_usage.sql"
  printf '```\n\n'

  printf '## Database Health Snapshot\n\n'
  printf '```text\n'
  "${psql_base[@]}" -f "infra/benchmark/ops-tuning/sql/04_db_health_snapshot.sql"
  printf '```\n'
} > "${OUT_FILE}"

printf 'Ops tuning report generated: %s\n' "${OUT_FILE}"
