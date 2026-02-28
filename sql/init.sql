CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS textsearch_ko;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'korean') THEN
        EXECUTE 'ALTER DATABASE ' || quote_ident(current_database()) ||
                ' SET default_text_search_config = ''korean''';
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS namuwiki_documents (
    id BIGSERIAL PRIMARY KEY,
    doc_hash TEXT NOT NULL UNIQUE,
    title TEXT,
    content TEXT NOT NULL,
    contributors TEXT,
    namespace TEXT,
    search_vector TSVECTOR,
    embedding VECTOR(384),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE namuwiki_documents
    ALTER COLUMN embedding TYPE VECTOR(384);

CREATE INDEX IF NOT EXISTS idx_namuwiki_documents_search_vector
    ON namuwiki_documents USING GIN (search_vector);

CREATE INDEX IF NOT EXISTS idx_namuwiki_documents_embedding_hnsw_cosine
    ON namuwiki_documents USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_namuwiki_documents_embedding_ivfflat_ip
    ON namuwiki_documents USING ivfflat (embedding vector_ip_ops) WITH (lists = 200);
