# Qwen Ingest 순차 전체 처리 전환 (2026-03-04)

## 1) 변경 배경

- 기존 `infra/db/scripts/ingest_namuwiki_qwen.py`는 샤드 기반 실행 경로(`QWEN_SHARD_COUNT`, `QWEN_SHARD_INDEX`)를 포함하고 있었습니다.
- 이번 작업 목표는 병렬/샤드 실행 로직을 제거하고, `infra/db/data/namuwiki_20210301.parquet` 전체를 단일 프로세스에서 순차 임베딩하는 것입니다.

## 2) 변경 파일 목록

- `infra/db/scripts/ingest_namuwiki_qwen.py`
- `README.md`

## 3) 동작 변경 요약 (사용자 영향)

- 샤드 관련 설정/분기를 제거했습니다.
  - 제거: `QWEN_SHARD_COUNT`, `QWEN_SHARD_INDEX`
  - 제거: 샤드 분배 계산 함수와 샤드 필터링 분기
- 진행률 기준이 샤드 대상 행이 아닌 전체 대상 행(`Target rows`)으로 변경되었습니다.
- 기본 실행은 전체 parquet 순차 처리이며, `MAX_ROWS`를 지정한 경우에만 상한을 적용합니다.
- README에서 샤드 실행 예시와 샤드 환경 변수 안내를 제거했습니다.
- `DB_COMMIT_ROWS`는 전체 범위를 제한하는 값이 아니라 DB 쓰기 플러시 단위임을 명시했습니다.
- 기본 `DB_COMMIT_ROWS`를 `512`로 조정하고, 진행률 출력 기본 간격(`QWEN_PROGRESS_EVERY`)은 `32`로 분리했습니다.

## 4) 검증 방법 (재현 가능한 명령)

### 4.1 문법 검증

```bash
python3 -m py_compile infra/db/scripts/ingest_namuwiki_qwen.py
```

- 결과: 성공 (exit code 0)

### 4.2 시그니처 검증 (샤드 파라미터 제거 확인)

```bash
python3 - <<'PY'
import inspect
from infra.db.scripts import ingest_namuwiki_qwen as q

sig = inspect.signature(q.parquet_rows)
params = list(sig.parameters)
assert 'shard_index' not in params
assert 'shard_count' not in params
print('parquet_rows-sequential-signature-ok', params)
PY
```

- 결과: `parquet_rows-sequential-signature-ok ['pq_module', 'parquet_path', 'batch_rows', 'max_rows']`

### 4.3 LSP 진단

- `infra/db/scripts/ingest_namuwiki_qwen.py` 에러 진단 결과: 0건

### 4.4 실행 로그 의미 확인

- 시작 로그에 아래 안내가 포함되도록 변경했습니다.
  - `Range config: MAX_ROWS=all, DB_COMMIT_ROWS is flush size only`

## 5) 롤백 또는 안전장치

- 롤백 경로: 아래 파일만 되돌리면 이전 샤드 방식으로 복구됩니다.
  - `infra/db/scripts/ingest_namuwiki_qwen.py`
  - `README.md`
- 안전장치: 대량 데이터 전체 실행 전 `MAX_ROWS`로 소량 드라이런을 권장합니다.
