#!/usr/bin/env bash
set -euo pipefail

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-luke}"
PGDATABASE="${PGDATABASE:-luke}"

OUT_DIR="${OPS_REPORT_DIR:-.artifacts/ops-tuning}"
OUT_FILE="${OUT_DIR}/ops-report-$(date +%Y%m%d-%H%M%S).md"

mkdir -p "${OUT_DIR}"

if command -v psql >/dev/null 2>&1; then
  USE_DOCKER_PSQL=0
  psql_base=(
    psql
    -h
    "${PGHOST}"
    -p
    "${PGPORT}"
    -U
    "${PGUSER}"
    -d
    "${PGDATABASE}"
    -X
    -v
    ON_ERROR_STOP=1
  )
else
  if ! command -v docker >/dev/null 2>&1; then
    printf 'Error: psql is not installed and docker is unavailable.\n' >&2
    exit 1
  fi

  PG_CONTAINER="${PG_CONTAINER:-pgvector}"

  if ! docker ps --format '{{.Names}}' | grep -qx "${PG_CONTAINER}"; then
    printf 'Error: psql is not installed and docker container "%s" is not running.\n' "${PG_CONTAINER}" >&2
    exit 1
  fi

  USE_DOCKER_PSQL=1
  psql_base=(
    docker
    exec
    -i
    "${PG_CONTAINER}"
    psql
    -U
    "${PGUSER}"
    -d
    "${PGDATABASE}"
    -X
    -v
    ON_ERROR_STOP=1
  )
fi

run_sql_file() {
  local sql_file="$1"

  if [[ "${USE_DOCKER_PSQL}" -eq 1 ]]; then
    "${psql_base[@]}" < "${sql_file}"
    return
  fi

  "${psql_base[@]}" -f "${sql_file}"
}

{
  printf '# PostgreSQL Ops Tuning Report\n\n'
  printf -- '- Generated At: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf -- '- Host: %s\n' "${PGHOST}"
  printf -- '- Port: %s\n' "${PGPORT}"
  printf -- '- Database: %s\n\n' "${PGDATABASE}"

  printf '## Top Queries by Total Exec Time\n\n'
  printf '```text\n'
  run_sql_file "infra/benchmark/ops-tuning/sql/01_top_total_exec.sql"
  printf '```\n\n'

  printf '## Vector Query Hotspots\n\n'
  printf '```text\n'
  run_sql_file "infra/benchmark/ops-tuning/sql/02_vector_query_hotspots.sql"
  printf '```\n\n'

  printf '## Index Usage\n\n'
  printf '```text\n'
  run_sql_file "infra/benchmark/ops-tuning/sql/03_index_usage.sql"
  printf '```\n\n'

  printf '## Database Health Snapshot\n\n'
  printf '```text\n'
  run_sql_file "infra/benchmark/ops-tuning/sql/04_db_health_snapshot.sql"
  printf '```\n'
} > "${OUT_FILE}"

printf 'Ops tuning report generated: %s\n' "${OUT_FILE}"
