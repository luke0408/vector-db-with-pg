# Qwen Ingest NaN/Inf 벡터 삽입 오류 대응 (2026-03-04)

## 1) 변경 배경

- 실행 중 `psycopg.errors.DataException: NaN not allowed in vector`가 발생해 적재가 중단되었습니다.
- 오류 지점은 `upsert_qwen_embeddings`의 `executemany`이며, 원인은 임베딩 벡터에 비정상 수치(NaN/Inf)가 포함된 경우입니다.

## 2) 변경 파일 목록

- `infra/db/scripts/ingest_namuwiki_qwen.py`
- `README.md`

## 3) 동작 변경 요약 (사용자 영향)

- 모델 출력 풀링/정규화 직후 `torch.nan_to_num`를 적용해 텐서 단계 NaN/Inf를 0으로 정규화합니다.
- DB insert 직전 Python 단계에서 벡터를 다시 검증해 비정상 수치가 남아 있으면 0으로 치환합니다.
- 치환된 행 수를 집계해 종료 로그에 `Sanitized vector rows (NaN/Inf -> 0)`로 출력합니다.
- 결과적으로 pgvector의 `NaN not allowed in vector`로 인한 즉시 실패를 방지합니다.

## 4) 검증 방법 (재현 가능한 명령)

### 4.1 문법 검증

```bash
python3 -m py_compile infra/db/scripts/ingest_namuwiki_qwen.py
```

- 결과: 성공 (exit code 0)

### 4.2 LSP 진단

- `infra/db/scripts/ingest_namuwiki_qwen.py` 에러 진단 결과: 0건

### 4.3 NaN/Inf 방어 스모크 테스트

```bash
python3 - <<'PY'
from infra.db.scripts.ingest_namuwiki_qwen import sanitize_vector_values, to_vector_literal

vec, changed = sanitize_vector_values([1.0, float('nan'), float('inf'), float('-inf')], 4)
assert changed is True
assert vec == [1.0, 0.0, 0.0, 0.0]
literal = to_vector_literal(vec)
assert "nan" not in literal.lower()
assert "inf" not in literal.lower()
print("nan-guard-smoke-ok", literal)
PY
```

- 결과: `nan-guard-smoke-ok [1.00000000,0.00000000,0.00000000,0.00000000]`

## 5) 롤백 또는 안전장치

- 롤백 경로: 아래 변경 파일만 되돌리면 됩니다.
  - `infra/db/scripts/ingest_namuwiki_qwen.py`
  - `README.md`
- 안전장치: 종료 로그의 `Sanitized vector rows` 값을 모니터링해 비정상 수치 발생 빈도를 추적할 수 있습니다.
