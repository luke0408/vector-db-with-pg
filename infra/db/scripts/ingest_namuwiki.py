import hashlib
import importlib
import os
import urllib.request
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple


DB_ROOT_DIR = Path(__file__).resolve().parents[1]
PROJECT_ROOT_DIR = Path(__file__).resolve().parents[3]
INIT_SQL_PATH = DB_ROOT_DIR / "sql" / "init.sql"

DEFAULT_HF_PARQUET_URL = (
    "https://huggingface.co/datasets/heegyu/namuwiki/resolve/main/"
    "namuwiki_20210301.parquet"
)
DEFAULT_LOCAL_PARQUET_PATH = DB_ROOT_DIR / "data" / "namuwiki_20210301.parquet"
DEFAULT_EMBED_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"


def load_dependencies():
    pyarrow_parquet = importlib.import_module("pyarrow.parquet")
    psycopg = importlib.import_module("psycopg")
    sentence_transformers = importlib.import_module("sentence_transformers")
    return pyarrow_parquet, psycopg, sentence_transformers


def load_dotenv(dotenv_path: Path) -> None:
    if not dotenv_path.exists():
        return
    for raw_line in dotenv_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None or value == "":
        return default
    return int(value)


def env_optional_int(name: str) -> Optional[int]:
    value = os.getenv(name)
    if value is None or value == "":
        return None
    return int(value)


def get_db_params() -> Dict[str, object]:
    user = os.getenv("PGUSER") or os.getenv("POSTGRES_USER") or "postgres"
    password = os.getenv("PGPASSWORD") or os.getenv("POSTGRES_PASSWORD") or ""
    dbname = os.getenv("PGDATABASE") or os.getenv("POSTGRES_DB") or user
    host = os.getenv("PGHOST") or "localhost"
    port = int(os.getenv("PGPORT") or os.getenv("POSTGRES_PORT") or "5432")

    return {
        "host": host,
        "port": port,
        "user": user,
        "password": password,
        "dbname": dbname,
        "autocommit": False,
    }


def ensure_parquet_file(source_url: str, target_path: Path) -> Path:
    target_path.parent.mkdir(parents=True, exist_ok=True)
    if target_path.exists() and target_path.stat().st_size > 0:
        return target_path

    print(f"Downloading parquet file to {target_path} ...")
    urllib.request.urlretrieve(source_url, target_path)  # nosec B310
    return target_path


def run_init_sql(conn) -> None:
    sql_text = INIT_SQL_PATH.read_text(encoding="utf-8")
    with conn.cursor() as cur:
        cur.execute(sql_text)
    conn.commit()


def resolve_ts_config(conn, requested: str) -> str:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT CASE
                WHEN EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = %s) THEN %s
                ELSE 'simple'
            END
            """,
            (requested, requested),
        )
        row = cur.fetchone()
    return row[0] if row else "simple"


def normalize_for_embedding(text: str, max_chars: int) -> str:
    normalized = " ".join(text.split())
    return normalized[:max_chars]


def to_vector_literal(vector_values: Sequence[float]) -> str:
    return "[" + ",".join(f"{float(v):.8f}" for v in vector_values) + "]"


def parquet_rows(
    pq_module,
    parquet_path: Path,
    batch_rows: int,
    max_rows: Optional[int],
) -> Iterable[Tuple[Optional[str], Optional[str], Optional[str], Optional[str]]]:
    parquet = pq_module.ParquetFile(parquet_path)
    total = 0
    for record_batch in parquet.iter_batches(
        batch_size=batch_rows,
        columns=["title", "text", "contributors", "namespace"],
    ):
        rows = record_batch.to_pydict()
        for title, text, contributors, namespace in zip(
            rows.get("title", []),
            rows.get("text", []),
            rows.get("contributors", []),
            rows.get("namespace", []),
        ):
            if max_rows is not None and total >= max_rows:
                return

            yield (
                str(title) if title is not None else None,
                str(text) if text is not None else None,
                str(contributors) if contributors is not None else None,
                str(namespace) if namespace is not None else None,
            )
            total += 1


def upsert_batch(
    conn,
    ts_config: str,
    rows: List[Tuple[str, Optional[str], str, Optional[str], Optional[str], str]],
) -> None:
    query = """
        INSERT INTO namuwiki_documents (
            doc_hash,
            title,
            content,
            contributors,
            namespace,
            search_vector,
            embedding,
            updated_at
        ) VALUES (
            %s,
            %s,
            %s,
            %s,
            %s,
            to_tsvector(%s::regconfig, concat_ws(' ', coalesce(%s, ''), coalesce(%s, ''))),
            %s,
            NOW()
        )
        ON CONFLICT (doc_hash) DO UPDATE SET
            title = EXCLUDED.title,
            content = EXCLUDED.content,
            contributors = EXCLUDED.contributors,
            namespace = EXCLUDED.namespace,
            search_vector = EXCLUDED.search_vector,
            embedding = EXCLUDED.embedding,
            updated_at = NOW()
    """

    payload = [
        (
            doc_hash,
            title,
            content,
            contributors,
            namespace,
            ts_config,
            title,
            content,
            embedding,
        )
        for doc_hash, title, content, contributors, namespace, embedding in rows
    ]

    with conn.cursor() as cur:
        cur.executemany(query, payload)
    conn.commit()


def main() -> None:
    load_dotenv(DB_ROOT_DIR / ".env")
    load_dotenv(PROJECT_ROOT_DIR / ".env")
    pq_module, psycopg, sentence_transformers = load_dependencies()

    parquet_url = os.getenv("HF_PARQUET_URL", DEFAULT_HF_PARQUET_URL)
    parquet_path = Path(
        os.getenv("LOCAL_PARQUET_PATH", str(DEFAULT_LOCAL_PARQUET_PATH))
    )
    embed_model_name = os.getenv("EMBED_MODEL", DEFAULT_EMBED_MODEL)
    batch_size = env_int("BATCH_SIZE", 128)
    parquet_batch_rows = env_int("PARQUET_BATCH_ROWS", 2048)
    db_commit_rows = env_int("DB_COMMIT_ROWS", 512)
    max_rows = env_optional_int("MAX_ROWS")
    max_text_chars = env_int("MAX_TEXT_CHARS", 4000)
    ts_config_requested = os.getenv("TS_CONFIG", "korean")

    local_parquet = ensure_parquet_file(parquet_url, parquet_path)
    db_params = get_db_params()

    inserted_or_updated = 0
    vector_dim: Optional[int] = None

    with psycopg.connect(**db_params) as conn:
        print("Initializing schema and extensions ...")
        run_init_sql(conn)
        ts_config = resolve_ts_config(conn, ts_config_requested)
        print(f"Using text search config: {ts_config}")

        print("Loading embedding model ...")
        embedder = sentence_transformers.SentenceTransformer(embed_model_name)

        docs_buffer: List[Tuple[Optional[str], str, Optional[str], Optional[str]]] = []
        for title, text, contributors, namespace in parquet_rows(
            pq_module,
            local_parquet,
            batch_rows=parquet_batch_rows,
            max_rows=max_rows,
        ):
            if not text:
                continue
            docs_buffer.append((title, text, contributors, namespace))
            if len(docs_buffer) < db_commit_rows:
                continue

            texts_for_embedding = [
                normalize_for_embedding(item[1], max_text_chars) for item in docs_buffer
            ]
            vectors = embedder.encode(
                texts_for_embedding,
                batch_size=batch_size,
                normalize_embeddings=True,
                show_progress_bar=False,
            )

            rows_for_db: List[
                Tuple[str, Optional[str], str, Optional[str], Optional[str], str]
            ] = []
            for (
                doc_title,
                doc_content,
                doc_contributors,
                doc_namespace,
            ), vector in zip(
                docs_buffer,
                vectors,
            ):
                if vector_dim is None:
                    vector_dim = len(vector)
                elif vector_dim != len(vector):
                    raise ValueError(
                        f"Embedding dimension mismatch: expected {vector_dim}, got {len(vector)}"
                    )

                doc_hash = hashlib.sha256(
                    f"{doc_title or ''}\n{doc_content}".encode("utf-8")
                ).hexdigest()
                rows_for_db.append(
                    (
                        doc_hash,
                        doc_title,
                        doc_content,
                        doc_contributors,
                        doc_namespace,
                        to_vector_literal(vector),
                    )
                )

            upsert_batch(conn, ts_config, rows_for_db)
            inserted_or_updated += len(rows_for_db)
            print(f"Processed rows: {inserted_or_updated}")
            docs_buffer = []

        if docs_buffer:
            texts_for_embedding = [
                normalize_for_embedding(item[1], max_text_chars) for item in docs_buffer
            ]
            vectors = embedder.encode(
                texts_for_embedding,
                batch_size=batch_size,
                normalize_embeddings=True,
                show_progress_bar=False,
            )

            rows_for_db = []
            for (
                doc_title,
                doc_content,
                doc_contributors,
                doc_namespace,
            ), vector in zip(
                docs_buffer,
                vectors,
            ):
                if vector_dim is None:
                    vector_dim = len(vector)
                elif vector_dim != len(vector):
                    raise ValueError(
                        f"Embedding dimension mismatch: expected {vector_dim}, got {len(vector)}"
                    )

                doc_hash = hashlib.sha256(
                    f"{doc_title or ''}\n{doc_content}".encode("utf-8")
                ).hexdigest()
                rows_for_db.append(
                    (
                        doc_hash,
                        doc_title,
                        doc_content,
                        doc_contributors,
                        doc_namespace,
                        to_vector_literal(vector),
                    )
                )

            upsert_batch(conn, ts_config, rows_for_db)
            inserted_or_updated += len(rows_for_db)

    print(f"Done. Total upserted rows: {inserted_or_updated}")


if __name__ == "__main__":
    main()
