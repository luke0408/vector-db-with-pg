#!/usr/bin/env bash
set -euo pipefail

ANN_BENCHMARKS_DIR="${ANN_BENCHMARKS_DIR:-$HOME/.cache/ann-benchmarks}"
ANN_BENCHMARKS_PYTHON="${ANN_BENCHMARKS_PYTHON:-}"
ANN_BENCHMARKS_CLEAN_STALE_CONTAINERS="${ANN_BENCHMARKS_CLEAN_STALE_CONTAINERS:-true}"
ANN_BENCHMARKS_TERMINATE_STALE_BACKENDS="${ANN_BENCHMARKS_TERMINATE_STALE_BACKENDS:-true}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ENV_FILE="$(cd "${SCRIPT_DIR}/../../.." && pwd)/.env"

if [ ! -d "${ANN_BENCHMARKS_DIR}" ]; then
  printf "ANN-Benchmarks directory not found: %s\n" "${ANN_BENCHMARKS_DIR}" >&2
  printf "Run: npm run benchmark:ann:setup\n" >&2
  exit 1
fi

select_python() {
  if [ -n "${ANN_BENCHMARKS_PYTHON}" ]; then
    if ! command -v "${ANN_BENCHMARKS_PYTHON}" >/dev/null 2>&1; then
      printf "Configured ANN_BENCHMARKS_PYTHON not found: %s\n" "${ANN_BENCHMARKS_PYTHON}" >&2
      exit 1
    fi
    printf "%s" "${ANN_BENCHMARKS_PYTHON}"
    return 0
  fi

  for candidate in python3.13 python3.12 python3.11 python3.10 python3; do
    if command -v "${candidate}" >/dev/null 2>&1; then
      printf "%s" "${candidate}"
      return 0
    fi
  done

  printf "No Python interpreter found. Install Python >= 3.10.\n" >&2
  exit 1
}

assert_python_version() {
  local bin="$1"
  local version
  version="$(${bin} -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
  local major="${version%%.*}"
  local minor="${version##*.}"

  if [ "${major}" -lt 3 ] || { [ "${major}" -eq 3 ] && [ "${minor}" -lt 10 ]; }; then
    printf "ANN-Benchmarks requires Python >= 3.10 (current: %s via %s).\n" "${version}" "${bin}" >&2
    exit 1
  fi
}

ensure_pg_env_passthrough() {
  local runner_file="${ANN_BENCHMARKS_DIR}/ann_benchmarks/runner.py"

  if [ ! -f "${runner_file}" ]; then
    printf "runner.py not found at %s\n" "${runner_file}" >&2
    exit 1
  fi

  "${PYTHON_BIN}" - <<'PY' "${runner_file}"
import sys
from pathlib import Path

runner_path = Path(sys.argv[1])
source = runner_path.read_text()

if "environment=container_environment" in source:
    raise SystemExit(0)

old = """    container = client.containers.run(
        definition.docker_tag,
        cmd,
        volumes={"""

new = """    container_environment = {
        key: value
        for key, value in os.environ.items()
        if key.startswith(\"ANN_BENCHMARKS_PG_\")
    }

    container = client.containers.run(
        definition.docker_tag,
        cmd,
        environment=container_environment,
        volumes={"""

if old not in source:
    raise SystemExit("Unable to patch runner.py: expected container.run block not found")

runner_path.write_text(source.replace(old, new, 1))
PY
}

is_truthy() {
  case "$1" in
    1|true|TRUE|True|yes|YES|Yes|y|Y|on|ON|On) return 0 ;;
    *) return 1 ;;
  esac
}

cleanup_stale_pgvector_containers() {
  local -a container_ids=()
  while IFS= read -r container_id; do
    if [ -n "${container_id}" ]; then
      container_ids+=("${container_id}")
    fi
  done < <(docker ps --quiet --filter "ancestor=ann-benchmarks-pgvector")

  if [ "${#container_ids[@]}" -eq 0 ]; then
    return 0
  fi

  if ! is_truthy "${ANN_BENCHMARKS_CLEAN_STALE_CONTAINERS}"; then
    printf "Found %d running ann-benchmarks-pgvector container(s).\n" "${#container_ids[@]}" >&2
    printf "Set ANN_BENCHMARKS_CLEAN_STALE_CONTAINERS=true to auto-clean them before running.\n" >&2
    return 0
  fi

  printf "Cleaning %d stale ann-benchmarks-pgvector container(s)...\n" "${#container_ids[@]}" >&2
  docker rm -f "${container_ids[@]}" >/dev/null
}

terminate_stale_pg_backends() {
  if ! is_truthy "${ANN_BENCHMARKS_TERMINATE_STALE_BACKENDS}"; then
    return 0
  fi

  local min_age_seconds="${ANN_BENCHMARKS_STALE_BACKEND_MIN_AGE_SECONDS:-300}"
  if [ -z "${min_age_seconds}" ] || [[ "${min_age_seconds}" == *[!0-9]* ]]; then
    min_age_seconds="300"
  fi

  local sql
  sql="WITH stale AS (
  SELECT pid,
         EXTRACT(EPOCH FROM (now() - backend_start))::int AS age_seconds,
         LEFT(query, 120) AS query_preview
  FROM pg_stat_activity
  WHERE pid <> pg_backend_pid()
    AND backend_type = 'client backend'
    AND EXTRACT(EPOCH FROM (now() - backend_start)) >= ${min_age_seconds}
    AND (
      query LIKE 'CREATE INDEX ON items USING hnsw%'
      OR query LIKE 'DROP TABLE IF EXISTS items%'
    )
)
SELECT format('pid=%s age=%ss terminated=%s query=%s',
              pid,
              age_seconds,
              pg_terminate_backend(pid),
              query_preview)
FROM stale;"

  local output
  if ! output="$(docker run --rm \
    --entrypoint psql \
    -e "PGPASSWORD=${ANN_BENCHMARKS_PG_PASSWORD}" \
    "ann-benchmarks-pgvector" \
      -h "${ANN_BENCHMARKS_PG_HOST}" \
      -p "${ANN_BENCHMARKS_PG_PORT}" \
      -U "${ANN_BENCHMARKS_PG_USER}" \
      -d "${ANN_BENCHMARKS_PG_DBNAME}" \
      -At \
      -v ON_ERROR_STOP=1 \
      -c "${sql}" 2>&1)"; then
    printf "Warning: failed to terminate stale PostgreSQL backends (%s). Continuing.\n" "${output}" >&2
    return 0
  fi

  if [ -n "${output}" ]; then
    printf "Terminating stale PostgreSQL backend(s) from prior ANN runs...\n" >&2
    printf "%s\n" "${output}" >&2
  fi
}

get_env_file_value() {
  local key="$1"

  if [ ! -f "${REPO_ENV_FILE}" ]; then
    return 0
  fi

  python3 - "${REPO_ENV_FILE}" "${key}" <<'PY'
import re
import sys
from pathlib import Path

env_path = Path(sys.argv[1])
target = sys.argv[2]

for raw_line in env_path.read_text().splitlines():
    line = raw_line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    key = key.strip()
    if key != target:
        continue
    value = value.strip()
    if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
        value = value[1:-1]
    value = re.sub(r"\s+#.*$", "", value).strip()
    print(value)
    break
PY
}

DATASET="${ANN_DATASET:-glove-100-angular}"
COUNT="${ANN_COUNT:-10}"
RUNS="${ANN_RUNS:-5}"
PARALLELISM="${ANN_PARALLELISM:-1}"
MAX_N_ALGORITHMS="${ANN_MAX_N_ALGORITHMS:-}"

POSTGRES_USER_DEFAULT="${POSTGRES_USER:-$(get_env_file_value POSTGRES_USER)}"
POSTGRES_PASSWORD_DEFAULT="${POSTGRES_PASSWORD:-$(get_env_file_value POSTGRES_PASSWORD)}"
POSTGRES_PORT_DEFAULT="${POSTGRES_PORT:-$(get_env_file_value POSTGRES_PORT)}"

export ANN_BENCHMARKS_PG_START_SERVICE=false
export ANN_BENCHMARKS_PG_HOST="${ANN_BENCHMARKS_PG_HOST:-${PGHOST:-host.docker.internal}}"
export ANN_BENCHMARKS_PG_PORT="${ANN_BENCHMARKS_PG_PORT:-${PGPORT:-${POSTGRES_PORT_DEFAULT:-5432}}}"
export ANN_BENCHMARKS_PG_USER="${ANN_BENCHMARKS_PG_USER:-${PGUSER:-${POSTGRES_USER_DEFAULT:-postgres}}}"
export ANN_BENCHMARKS_PG_PASSWORD="${ANN_BENCHMARKS_PG_PASSWORD:-${PGPASSWORD:-${POSTGRES_PASSWORD_DEFAULT:-postgres}}}"
export ANN_BENCHMARKS_PG_DBNAME="${ANN_BENCHMARKS_PG_DBNAME:-${PGDATABASE:-${POSTGRES_USER_DEFAULT:-postgres}}}"

PYTHON_BIN="${ANN_BENCHMARKS_DIR}/.venv/bin/python"
if [ ! -x "${PYTHON_BIN}" ]; then
  PYTHON_BIN="$(select_python)"
fi
assert_python_version "${PYTHON_BIN}"
ensure_pg_env_passthrough
cleanup_stale_pgvector_containers
terminate_stale_pg_backends

(
  cd "${ANN_BENCHMARKS_DIR}"
  run_args=(
    --algorithm pgvector
    --dataset "${DATASET}"
    --count "${COUNT}"
    --runs "${RUNS}"
    --parallelism "${PARALLELISM}"
  )

  if [ -n "${MAX_N_ALGORITHMS}" ]; then
    run_args+=(--max-n-algorithms "${MAX_N_ALGORITHMS}")
  fi

  "${PYTHON_BIN}" run.py "${run_args[@]}"

  "${PYTHON_BIN}" plot.py --dataset "${DATASET}" --count "${COUNT}"
)

printf "ANN-Benchmarks run complete for dataset=%s\n" "${DATASET}"
