CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE EXTENSION IF NOT EXISTS textsearch_ko;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'korean') THEN
        EXECUTE 'ALTER DATABASE ' || quote_ident(current_database()) ||
                ' SET default_text_search_config = ''korean''';
    END IF;
END
$$;

CREATE SEQUENCE IF NOT EXISTS global_id_seq;

CREATE TABLE IF NOT EXISTS namuwiki_documents (
    id BIGINT PRIMARY KEY DEFAULT nextval('global_id_seq'),
    doc_hash TEXT NOT NULL UNIQUE,
    title TEXT,
    content TEXT NOT NULL,
    contributors TEXT,
    namespace TEXT,
    search_vector TSVECTOR,
    embedding VECTOR(384),
    textlen INTEGER,
    fts TSVECTOR,
    embedding_qwen VECTOR(1024),
    embedding_hnsw VECTOR(1024),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE namuwiki_documents
    ALTER COLUMN id SET DEFAULT nextval('global_id_seq');

ALTER TABLE namuwiki_documents
    ADD COLUMN IF NOT EXISTS textlen INTEGER,
    ADD COLUMN IF NOT EXISTS fts TSVECTOR,
    ADD COLUMN IF NOT EXISTS embedding_qwen VECTOR(1024),
    ADD COLUMN IF NOT EXISTS embedding_hnsw VECTOR(1024);

ALTER TABLE namuwiki_documents
    ALTER COLUMN embedding TYPE VECTOR(384);

SELECT setval(
    'global_id_seq',
    GREATEST((SELECT COALESCE(MAX(id), 0) FROM namuwiki_documents), 1),
    TRUE
);

CREATE INDEX IF NOT EXISTS idx_namuwiki_documents_search_vector
    ON namuwiki_documents USING GIN (search_vector);

CREATE INDEX IF NOT EXISTS idx_namuwiki_documents_fts
    ON namuwiki_documents USING GIN (fts);

CREATE INDEX IF NOT EXISTS idx_namuwiki_documents_embedding_hnsw_cosine
    ON namuwiki_documents USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_namuwiki_documents_embedding_qwen_hnsw_cosine
    ON namuwiki_documents USING hnsw (embedding_hnsw vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_namuwiki_documents_embedding_ivfflat_ip
    ON namuwiki_documents USING ivfflat (embedding vector_ip_ops) WITH (lists = 200);

CREATE TABLE IF NOT EXISTS namuwiki_document_embeddings_qwen (
    doc_hash TEXT PRIMARY KEY REFERENCES namuwiki_documents(doc_hash) ON DELETE CASCADE,
    embedding VECTOR(1024) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE namuwiki_document_embeddings_qwen
    ALTER COLUMN embedding TYPE VECTOR(1024);

CREATE INDEX IF NOT EXISTS idx_namuwiki_document_embeddings_qwen_hnsw_cosine
    ON namuwiki_document_embeddings_qwen USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_namuwiki_document_embeddings_qwen_ivfflat_ip
    ON namuwiki_document_embeddings_qwen USING ivfflat (embedding vector_ip_ops) WITH (lists = 200);

CREATE TABLE IF NOT EXISTS search_supported_languages (
    language TEXT PRIMARY KEY,
    table_suffix TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS search_bm25_language_settings (
    language TEXT PRIMARY KEY REFERENCES search_supported_languages(language) ON DELETE CASCADE,
    k1 DOUBLE PRECISION NOT NULL DEFAULT 1.2,
    b DOUBLE PRECISION NOT NULL DEFAULT 0.75,
    last_indexed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS search_managed_tables (
    table_name TEXT PRIMARY KEY,
    id_column TEXT NOT NULL DEFAULT 'id',
    doc_hash_column TEXT,
    title_column TEXT NOT NULL DEFAULT 'title',
    content_column TEXT NOT NULL DEFAULT 'content',
    textlen_column TEXT NOT NULL DEFAULT 'textlen',
    fts_column TEXT NOT NULL DEFAULT 'fts',
    embedding_column TEXT NOT NULL DEFAULT 'embedding_qwen',
    embedding_hnsw_column TEXT NOT NULL DEFAULT 'embedding_hnsw',
    language TEXT NOT NULL REFERENCES search_supported_languages(language),
    embedding_dim INTEGER NOT NULL DEFAULT 1024,
    embedding_hnsw_dim INTEGER NOT NULL DEFAULT 1024,
    reduction_method TEXT NOT NULL DEFAULT 'prefix_truncation',
    description TEXT,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS search_managed_table_status (
    table_name TEXT PRIMARY KEY REFERENCES search_managed_tables(table_name) ON DELETE CASCADE,
    row_count BIGINT NOT NULL DEFAULT 0,
    embedding_coverage DOUBLE PRECISION NOT NULL DEFAULT 0,
    fts_coverage DOUBLE PRECISION NOT NULL DEFAULT 0,
    embedding_ready BOOLEAN NOT NULL DEFAULT FALSE,
    fts_ready BOOLEAN NOT NULL DEFAULT FALSE,
    bm25_ready BOOLEAN NOT NULL DEFAULT FALSE,
    search_eligible BOOLEAN NOT NULL DEFAULT FALSE,
    backfill_status TEXT NOT NULL DEFAULT 'idle',
    backfill_total_rows BIGINT NOT NULL DEFAULT 0,
    backfill_processed_rows BIGINT NOT NULL DEFAULT 0,
    backfill_last_processed_id BIGINT,
    backfill_cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
    backfill_last_started_at TIMESTAMPTZ,
    backfill_last_completed_at TIMESTAMPTZ,
    backfill_last_error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_search_managed_tables_default
    ON search_managed_tables ((is_default))
    WHERE is_default = TRUE;

CREATE OR REPLACE FUNCTION bm25_tsvector_token_stats(input_vector tsvector)
RETURNS TABLE(token TEXT, tf INTEGER)
LANGUAGE sql
IMMUTABLE
AS $$
  WITH raw_lexemes AS (
    SELECT
      match[1] AS lexeme,
      match[2] AS positions
    FROM regexp_split_to_table(COALESCE(input_vector::text, ''), E'\\s+') AS part
    CROSS JOIN LATERAL regexp_match(
      part,
      E'^''((?:[^'']|'''')+)''(?::([0-9,]+))?$'
    ) AS match
    WHERE part <> ''
  )
  SELECT
    replace(lexeme, '''''', '''') AS token,
    CASE
      WHEN positions IS NULL OR positions = '' THEN 1
      ELSE COALESCE(array_length(string_to_array(positions, ','), 1), 1)
    END AS tf
  FROM raw_lexemes
  WHERE lexeme IS NOT NULL
$$;

DO $$
DECLARE
    config_record RECORD;
    normalized_suffix TEXT;
BEGIN
    FOR config_record IN
        SELECT cfgname
        FROM pg_ts_config
        WHERE cfgname IN ('english', 'korean', 'japanese', 'chinese')
        ORDER BY cfgname ASC
    LOOP
        normalized_suffix := COALESCE(
            NULLIF(regexp_replace(lower(config_record.cfgname), '[^a-z0-9]+', '_', 'g'), ''),
            'lang_' || substr(md5(config_record.cfgname), 1, 6)
        );

        INSERT INTO search_supported_languages (language, table_suffix)
        VALUES (config_record.cfgname, normalized_suffix)
        ON CONFLICT (language) DO NOTHING;

        INSERT INTO search_bm25_language_settings (language)
        VALUES (config_record.cfgname)
        ON CONFLICT (language) DO NOTHING;

        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I (
                tablename TEXT PRIMARY KEY,
                recordcount BIGINT NOT NULL DEFAULT 0,
                sumlen BIGINT NOT NULL DEFAULT 0,
                avglen DOUBLE PRECISION NOT NULL DEFAULT 0
            )',
            'bm25length_' || normalized_suffix
        );

        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I (
                id BIGINT NOT NULL,
                token TEXT NOT NULL,
                tf INTEGER NOT NULL,
                PRIMARY KEY (id, token)
            )',
            'bm25tokens_' || normalized_suffix
        );

        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS %I ON %I (token)',
            'idx_bm25tokens_' || normalized_suffix || '_token',
            'bm25tokens_' || normalized_suffix
        );

        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I (
                token TEXT PRIMARY KEY,
                tfdoc BIGINT NOT NULL
            )',
            'bm25idf_' || normalized_suffix
        );

        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I (
                row_id BIGSERIAL PRIMARY KEY,
                status SMALLINT NOT NULL DEFAULT 0,
                task_type SMALLINT NOT NULL,
                table_name TEXT NOT NULL,
                id BIGINT NOT NULL,
                old_len INTEGER,
                old_fts TSVECTOR,
                new_len INTEGER,
                new_fts TSVECTOR,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )',
            'bm25tasks_' || normalized_suffix
        );

        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS %I ON %I (status, row_id)',
            'idx_bm25tasks_' || normalized_suffix || '_status_row',
            'bm25tasks_' || normalized_suffix
        );

        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS %I ON %I (id)',
            'idx_bm25tasks_' || normalized_suffix || '_id',
            'bm25tasks_' || normalized_suffix
        );
    END LOOP;
END
$$;

INSERT INTO search_managed_tables (
    table_name,
    id_column,
    doc_hash_column,
    title_column,
    content_column,
    textlen_column,
    fts_column,
    embedding_column,
    embedding_hnsw_column,
    language,
    embedding_dim,
    embedding_hnsw_dim,
    reduction_method,
    description,
    is_default,
    is_active
)
SELECT
    'namuwiki_documents',
    'id',
    'doc_hash',
    'title',
    'content',
    'textlen',
    'fts',
    'embedding_qwen',
    'embedding_hnsw',
    COALESCE(
      (SELECT language FROM search_supported_languages WHERE language = 'korean'),
      (SELECT language FROM search_supported_languages WHERE language = 'simple'),
      (SELECT language FROM search_supported_languages ORDER BY language ASC LIMIT 1)
    ),
    1024,
    1024,
    'prefix_truncation',
    'Phase 1 managed registration for existing NamuWiki documents.',
    TRUE,
    TRUE
ON CONFLICT (table_name) DO NOTHING;
