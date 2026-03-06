# Qwen Ingest Killed 대응 및 메모리 안전화 (2026-03-03)

## 1) 변경 배경

- 실행 로그에서 `Qwen shard progress ... 128/867024` 직후 프로세스가 `killed` 되었고, 종료 시점에 `resource_tracker leaked semaphore` 경고가 뒤따랐습니다.
- `infra/db/scripts/ingest_namuwiki_qwen.py`를 확인한 결과, `QWEN_BATCH_SIZE` 환경 변수를 읽고도 실제 임베딩 추론 호출에서는 사용하지 않았습니다.
- 기존 로직은 `docs_buffer`(기본 `DB_COMMIT_ROWS=128`) 전체를 한 번에 모델 forward 하므로, 긴 텍스트 + 대형 모델(Qwen3-VL-Embedding-8B) 조합에서 메모리 피크가 크게 증가합니다.
- `resource_tracker` 경고는 원인이라기보다 강제 종료(SIGKILL/OOM 이후) 시점의 2차 증상으로 해석됩니다.

## 2) 변경 파일 목록

- `infra/db/scripts/ingest_namuwiki_qwen.py`
- `README.md`

## 3) 동작 변경 요약 (사용자 영향)

- `QWEN_BATCH_SIZE`를 실제 임베딩 마이크로배치 크기로 적용했습니다.
  - 변경 전: 임베딩 1회 호출당 문서 수 = `DB_COMMIT_ROWS` (기본 128)
  - 변경 후: 임베딩 1회 호출당 문서 수 = `QWEN_BATCH_SIZE` (기본 4)
  - 기본값 기준으로 단일 forward 배치 크기 32배 축소 (`128 -> 4`)
- 디바이스 자동 감지를 추가했습니다 (`cuda` -> `mps` -> `cpu` 우선순위).
- 모델 로딩 메모리 옵션을 추가했습니다.
  - `QWEN_LOW_CPU_MEM_USAGE=true` (기본값)
  - `QWEN_DEVICE_MAP` (선택)
- 환경 변수 유효성 검증을 추가했습니다.
  - `QWEN_BATCH_SIZE`, `PARQUET_BATCH_ROWS`, `DB_COMMIT_ROWS`, `QWEN_MAX_TOKENS`는 1 이상이어야 실행됩니다.
- 시작 시 실제 임베딩 설정(`device`, `dtype`, `qwen_batch_size`, `db_commit_rows`)을 출력해 운영 관측성을 높였습니다.
- README의 Qwen 예시 값을 스크립트 기본값(안전한 배치)과 일치하도록 조정하고 메모리 튜닝 가이드를 추가했습니다.

## 4) 검증 방법 (재현 가능한 명령 + 결과)

### 4.1 Python 문법 검증

```bash
python3 -m py_compile infra/db/scripts/ingest_namuwiki_qwen.py
```

- 결과: 성공 (출력 없음, exit code 0)

### 4.2 마이크로배치 동작 스모크 테스트

```bash
python3 - <<'PY'
from infra.db.scripts import ingest_namuwiki_qwen as q

calls = []

orig = q.embed_texts

def fake_embed_texts(torch_module, tokenizer, model, texts, max_tokens, target_dim):
    calls.append(len(texts))
    return [[0.0] * target_dim for _ in texts]

q.embed_texts = fake_embed_texts
try:
    vectors = q.embed_texts_in_batches(
        torch_module=None,
        tokenizer=None,
        model=None,
        texts=[f"row-{i}" for i in range(10)],
        max_tokens=16,
        target_dim=3,
        batch_size=4,
    )
    assert calls == [4, 4, 2], calls
    assert len(vectors) == 10
finally:
    q.embed_texts = orig

print("micro-batch-smoke-ok", calls)
PY
```

- 결과: `micro-batch-smoke-ok [4, 4, 2]`

### 4.3 정적 진단

- `lsp_diagnostics` 수행 결과, 에러는 없고 기존 동적 import/타입 미지정 구조에서 발생한 경고만 존재합니다.

## 5) 롤백 또는 안전장치

- 롤백 경로: 아래 파일 변경분만 되돌리면 됩니다.
  - `infra/db/scripts/ingest_namuwiki_qwen.py`
  - `README.md`
- 안전성: DB 스키마/테이블 구조 및 upsert SQL 자체는 변경하지 않았고, 임베딩 호출 단위를 메모리 친화적으로 분할한 것이 핵심입니다.
- 운영 권장값(메모리 부족 시):
  - `QWEN_BATCH_SIZE=1` 또는 `2`
  - Apple Silicon: `QWEN_DEVICE=mps`
  - 필요 시 `QWEN_DEVICE_MAP=auto`
