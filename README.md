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
```

### 접속 정보

- pgAdmin: http://localhost:${PGADMIN_PORT:-8112}
- Postgres(pgvector): localhost:${POSTGRES_PORT:-5432}

## 디렉터리

- `pgadmin/data`: pgAdmin 데이터
- `pgvector/data`: Postgres 데이터
