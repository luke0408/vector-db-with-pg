# vector-search-db

PostgreSQL + pgvector schema/infra repository.

## Included

- `docker-compose.yml`
- `Dockerfile.pgvector`
- `sql/init.sql`
- `scripts/ingest_namuwiki.py`
- `requirements.txt`

## Quick start

1. Copy `.env.example` to `.env` and adjust values.
2. Run `docker compose up -d --build`.
3. Initialize schema:
   - `docker exec -i pgvector psql -U "$POSTGRES_USER" -d "${POSTGRES_DB:-$POSTGRES_USER}" < sql/init.sql`
