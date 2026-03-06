# vector-search-db

PostgreSQL + pgvector schema/infra repository.

## Included

- `docker-compose.yml`
- `Dockerfile.pgvector`
- `infra/db/sql/init.sql`
- `infra/db/scripts/ingest_namuwiki.py`
- `infra/db/scripts/ingest_namuwiki_qwen.py`
- `infra/db/requirements.txt`

## Quick start

1. Copy `.env.example` to `.env` and adjust values.
2. Run `docker compose up -d --build`.
3. Initialize schema:
   - `docker exec -i pgvector psql -U "$POSTGRES_USER" -d "${POSTGRES_DB:-$POSTGRES_USER}" < infra/db/sql/init.sql`
