#!/usr/bin/env bash
set -euo pipefail

ANN_BENCHMARKS_DIR="${ANN_BENCHMARKS_DIR:-$HOME/.cache/ann-benchmarks}"
ANN_BENCHMARKS_PYTHON="${ANN_BENCHMARKS_PYTHON:-}"

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
    printf "Set ANN_BENCHMARKS_PYTHON to a newer interpreter, e.g. python3.13.\n" >&2
    exit 1
  fi
}

ensure_pg_env_passthrough() {
  local runner_file="${ANN_BENCHMARKS_DIR}/ann_benchmarks/runner.py"

  if [ ! -f "${runner_file}" ]; then
    printf "runner.py not found at %s\n" "${runner_file}" >&2
    exit 1
  fi

  "${VENV_PYTHON}" - <<'PY' "${runner_file}"
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

if [ ! -d "${ANN_BENCHMARKS_DIR}" ]; then
  git clone https://github.com/erikbern/ann-benchmarks "${ANN_BENCHMARKS_DIR}"
else
  git -C "${ANN_BENCHMARKS_DIR}" fetch origin main
  git -C "${ANN_BENCHMARKS_DIR}" checkout main
  git -C "${ANN_BENCHMARKS_DIR}" pull --ff-only origin main
fi

PYTHON_BIN="$(select_python)"
assert_python_version "${PYTHON_BIN}"

VENV_DIR="${ANN_BENCHMARKS_DIR}/.venv"
"${PYTHON_BIN}" -m venv "${VENV_DIR}"

VENV_PYTHON="${VENV_DIR}/bin/python"
"${VENV_PYTHON}" -m pip install --upgrade pip setuptools wheel
"${VENV_PYTHON}" -m pip install -r "${ANN_BENCHMARKS_DIR}/requirements.txt"
ensure_pg_env_passthrough
(
  cd "${ANN_BENCHMARKS_DIR}"
  "${VENV_PYTHON}" install.py --algorithm pgvector
)

printf "ANN-Benchmarks setup complete at %s\n" "${ANN_BENCHMARKS_DIR}"
