# Vector DB Study

이 저장소는 다음 도서를 기반으로 스터디를 진행합니다.

- 도서: 벡터 데이터베이스 설계와 구축 (Vector DBMS & RAG)
- 저자: 송한림
- 출판사: 아이리포
- 발행일: 2025-03-01
- 링크: https://www.yes24.com/product/goods/142771026

## 목표

- Vector DBMS와 RAG 관련 핵심 개념 정리
- 실습을 통한 설계/구축 경험 축적

## 실행 방법

Docker Compose로 pgvector와 pgAdmin을 실행합니다.

```bash
docker compose up -d
```

### 환경 변수

`.env` 파일을 생성해서 아래 변수를 지정하세요.

```env
PGADMIN_DEFAULT_EMAIL=
PGADMIN_DEFAULT_PASSWORD=
POSTGRES_USER=
POSTGRES_PASSWORD=
PGADMIN_PORT=8112
POSTGRES_PORT=5432
DOCKER_PLATFORM=linux/arm64
```

- Apple Silicon Mac: 기본값 `linux/arm64`를 사용하세요.
- Intel Mac: `DOCKER_PLATFORM=linux/amd64`로 변경하세요.

### 접속 정보

- pgAdmin: http://localhost:${PGADMIN_PORT:-8112}
- Postgres(pgvector): localhost:${POSTGRES_PORT:-5432}

## 디렉터리

- `pgadmin/data`: pgAdmin 데이터
- `pgvector/data`: Postgres 데이터

## namuwiki parquet 적재 + 임베딩

아래 순서로 `heegyu/namuwiki` parquet를 pgvector에 넣고 임베딩까지 생성할 수 있습니다.

1. 컨테이너 실행

```bash
docker compose up -d --build
```

2. 파이썬 의존성 설치

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r infra/db/requirements.txt
```

3. 확장/테이블 초기화 (`vector`, `textsearch_ko` 포함)

```bash
docker exec -i pgvector psql -U "$POSTGRES_USER" -d "${POSTGRES_DB:-$POSTGRES_USER}" < infra/db/sql/init.sql
```

4. 적재 + 임베딩 실행

```bash
python infra/db/scripts/ingest_namuwiki.py
```

Qwen3-VL-Embedding-8B 임베딩 실행:

```bash
python infra/db/scripts/ingest_namuwiki_qwen.py
```

선택 환경 변수:

```env
HF_PARQUET_URL=https://huggingface.co/datasets/heegyu/namuwiki/resolve/main/namuwiki_20210301.parquet
LOCAL_PARQUET_PATH=./data/namuwiki_20210301.parquet
EMBED_MODEL=sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2
QWEN_EMBED_MODEL=Qwen/Qwen3-VL-Embedding-8B
QWEN_EMBED_DIM=1024
QWEN_BATCH_SIZE=2
QWEN_MIN_BATCH_SIZE=1
QWEN_MAX_TOKENS=2048
QWEN_MIN_TOKENS=256
QWEN_DEVICE=cuda
QWEN_DTYPE=auto
QWEN_LOW_CPU_MEM_USAGE=true
QWEN_CLEAR_CACHE_EVERY_BATCH=false
QWEN_MPS_MEMORY_FRACTION=
QWEN_DEVICE_MAP=
SKIP_INIT_SQL=false
TS_CONFIG=korean
PARQUET_BATCH_ROWS=256
DB_COMMIT_ROWS=512
MAX_ROWS=1000
MAX_TEXT_CHARS=4000
```

메모리 이슈가 있으면 아래 값을 먼저 조정하세요.

- `QWEN_BATCH_SIZE`: 임베딩 **마이크로배치** 크기입니다. OOM/Killed가 발생하면 `1~2`로 낮추세요.
- `DB_COMMIT_ROWS`: DB upsert 묶음 크기(플러시 단위)입니다. 전체 처리 범위를 제한하지 않습니다.
- 전체 범위 임베딩은 `MAX_ROWS`를 비우거나 미설정하면 됩니다.
- 메모리가 부족하면 `QWEN_BATCH_SIZE=1`, `QWEN_MAX_TOKENS=1024` 또는 `768`으로 낮추세요.
- Apple Silicon(`QWEN_DEVICE=mps`)에서는 `QWEN_CLEAR_CACHE_EVERY_BATCH=true`를 권장합니다.
- 임베딩에 NaN/Inf가 발생하면 ingest 스크립트가 해당 값을 `0`으로 치환해 pgvector 삽입 오류를 방지합니다.

두 임베딩 결과 비교:

```bash
python infra/db/scripts/compare_embedding_models.py --sample-size 200 --query-count 30 --neighbor-k 10 --label minilm-vs-qwen
```

샘플 검증 쿼리:

```sql
SELECT COUNT(*) FROM namuwiki_documents;

SELECT id, title,
       ts_rank_cd(search_vector, plainto_tsquery('korean', '무궁화 꽃')) AS rank
FROM namuwiki_documents
WHERE search_vector @@ plainto_tsquery('korean', '무궁화 꽃')
ORDER BY rank DESC
LIMIT 5;
```

## 검색 API: embeddingModel 선택(base/qwen3)

하이브리드 검색 엔드포인트는 임베딩 모델을 선택할 수 있습니다.

- `embeddingModel: "base"` → `namuwiki_documents.embedding` (`VECTOR(384)`) 사용
- `embeddingModel: "qwen3"` → `namuwiki_document_embeddings_qwen.embedding` (`VECTOR(1024)`) 사용
- 미지정 시 기본값은 `base`

요청 예시:

```bash
curl -X POST http://localhost:3000/api/search/hybrid \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "ARM 아키텍처",
    "offset": 0,
    "limit": 10,
    "mode": "hnsw",
    "bm25Enabled": true,
    "hybridRatio": 50,
    "embeddingModel": "qwen3"
  }'
```

응답 `meta`에는 실제 사용 모델이 `embeddingModelUsed`로 내려옵니다.
