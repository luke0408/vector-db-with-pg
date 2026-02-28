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
pip install -r requirements.txt
```

3. 확장/테이블 초기화 (`vector`, `textsearch_ko` 포함)

```bash
docker exec -i pgvector psql -U "$POSTGRES_USER" -d "${POSTGRES_DB:-$POSTGRES_USER}" < sql/init.sql
```

4. 적재 + 임베딩 실행

```bash
python scripts/ingest_namuwiki.py
```

선택 환경 변수:

```env
HF_PARQUET_URL=https://huggingface.co/datasets/heegyu/namuwiki/resolve/main/namuwiki_20210301.parquet
LOCAL_PARQUET_PATH=./data/namuwiki_20210301.parquet
EMBED_MODEL=sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2
TS_CONFIG=korean
BATCH_SIZE=128
PARQUET_BATCH_ROWS=2048
DB_COMMIT_ROWS=512
MAX_ROWS=1000
MAX_TEXT_CHARS=4000
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
