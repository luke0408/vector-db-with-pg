# Qwen Ingest MPS 메모리 가드 추가 (2026-03-04)

## 1) 변경 배경

- 순차 전체 처리로 전환 후에도 Apple Silicon MPS 환경에서 메모리 압박이 커서 처리 정체가 발생할 수 있었습니다.
- 기존 구현은 고정 `QWEN_BATCH_SIZE`/`QWEN_MAX_TOKENS`로 추론을 시도해 OOM 시 자동 완화 경로가 없었습니다.

## 2) 변경 파일 목록

- `infra/db/scripts/ingest_namuwiki_qwen.py`
- `README.md`

## 3) 동작 변경 요약

- 추론 컨텍스트를 `torch.no_grad()`에서 `torch.inference_mode()`로 변경했습니다.
- OOM 대응 적응형 가드를 추가했습니다.
  - 1차: 배치 분할(half split)
  - 2차: 토큰 상한 축소(`max_tokens` downscale)
  - 최소치까지 내려가도 실패하면 명확한 오류를 발생시킵니다.
- 디바이스 캐시 정리 함수를 추가했습니다.
  - CUDA: `torch.cuda.empty_cache()`
  - MPS: `torch.mps.empty_cache()`
  - 공통: `gc.collect()`
- 새 환경 변수:
  - `QWEN_MIN_BATCH_SIZE` (기본 `1`)
  - `QWEN_MIN_TOKENS` (기본 `256`)
  - `QWEN_CLEAR_CACHE_EVERY_BATCH` (MPS 기본 `true`, 그 외 기본 `false`)
  - `QWEN_MPS_MEMORY_FRACTION` (선택, `(0,1]`)
- 기본 배치 크기를 `QWEN_BATCH_SIZE=2`로 낮췄습니다.

## 4) 검증

### 4.1 문법 검증

```bash
python3 -m py_compile infra/db/scripts/ingest_namuwiki_qwen.py
```

- 결과: 성공 (exit code 0)

### 4.2 LSP 진단

- `infra/db/scripts/ingest_namuwiki_qwen.py` error diagnostics: 0건

### 4.3 스모크 검증

- 환경 변수 존재/유효성 검사 로직 추가 후 import 및 정적 검증 수행

## 5) 운영 권장값 (메모리 압박 시)

```bash
QWEN_DEVICE=mps \
QWEN_BATCH_SIZE=1 \
QWEN_MIN_BATCH_SIZE=1 \
QWEN_MAX_TOKENS=1024 \
QWEN_MIN_TOKENS=256 \
QWEN_CLEAR_CACHE_EVERY_BATCH=true \
QWEN_PROGRESS_EVERY=1 \
python3 infra/db/scripts/ingest_namuwiki_qwen.py
```

필요하면 `QWEN_MAX_TOKENS=768`까지 추가로 낮출 수 있습니다.
