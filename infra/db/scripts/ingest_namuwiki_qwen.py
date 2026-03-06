#!/usr/bin/env python3
import hashlib
import importlib
import gc
import math
import os
import time
import urllib.request
from collections import deque
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
DEFAULT_QWEN_MODEL = "Qwen/Qwen3-VL-Embedding-8B"
DEFAULT_QWEN_EMBED_DIM = 1024


def load_dependencies():
    pyarrow_parquet = importlib.import_module("pyarrow.parquet")
    psycopg = importlib.import_module("psycopg")
    torch = importlib.import_module("torch")
    transformers = importlib.import_module("transformers")
    return pyarrow_parquet, psycopg, torch, transformers


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


def env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)

    if value is None or value == "":
        return default

    return value.strip().lower() in {"1", "true", "yes", "on"}


def env_optional_float(name: str) -> Optional[float]:
    value = os.getenv(name)

    if value is None or value == "":
        return None

    return float(value)


def resolve_default_device(torch_module) -> str:
    if torch_module.cuda.is_available():
        return "cuda"

    mps_backend = getattr(torch_module.backends, "mps", None)
    if mps_backend is not None and mps_backend.is_available():
        return "mps"

    return "cpu"


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
    urllib.request.urlretrieve(source_url, target_path)
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


def sanitize_vector_values(
    vector_values: Sequence[float], expected_dim: int
) -> Tuple[List[float], bool]:
    if len(vector_values) != expected_dim:
        raise ValueError(
            f"Embedding dimension mismatch during sanitize: expected {expected_dim}, got {len(vector_values)}"
        )

    sanitized: List[float] = []
    had_invalid = False

    for value in vector_values:
        value_float = float(value)
        if math.isfinite(value_float):
            sanitized.append(value_float)
            continue

        had_invalid = True
        sanitized.append(0.0)

    return sanitized, had_invalid


def render_progress_bar(
    label: str,
    current: int,
    total: int,
    width: int,
    is_complete: bool = False,
) -> None:
    if total <= 0:
        return

    bounded_current = min(current, total)
    ratio = bounded_current / total
    filled = min(width, int(ratio * width))
    bar = "=" * filled + "." * (width - filled)
    line = f"{label} [{bar}] {bounded_current}/{total} ({ratio * 100:6.2f}%)"

    if is_complete:
        print(f"\r{line}")
        return

    print(f"\r{line}", end="", flush=True)


def parquet_rows(
    pq_module,
    parquet_path: Path,
    batch_rows: int,
    max_rows: Optional[int],
) -> Iterable[Tuple[Optional[str], Optional[str], Optional[str], Optional[str]]]:
    parquet = pq_module.ParquetFile(parquet_path)
    yielded = 0

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
            if max_rows is not None and yielded >= max_rows:
                return

            yield (
                str(title) if title is not None else None,
                str(text) if text is not None else None,
                str(contributors) if contributors is not None else None,
                str(namespace) if namespace is not None else None,
            )
            yielded += 1


def upsert_documents(
    conn,
    ts_config: str,
    rows: List[Tuple[str, Optional[str], str, Optional[str], Optional[str]]],
) -> None:
    query = """
        INSERT INTO namuwiki_documents (
            doc_hash,
            title,
            content,
            contributors,
            namespace,
            search_vector,
            updated_at
        ) VALUES (
            %s,
            %s,
            %s,
            %s,
            %s,
            to_tsvector(%s::regconfig, concat_ws(' ', coalesce(%s, ''), coalesce(%s, ''))),
            NOW()
        )
        ON CONFLICT (doc_hash) DO UPDATE SET
            title = EXCLUDED.title,
            content = EXCLUDED.content,
            contributors = EXCLUDED.contributors,
            namespace = EXCLUDED.namespace,
            search_vector = EXCLUDED.search_vector,
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
        )
        for doc_hash, title, content, contributors, namespace in rows
    ]

    with conn.cursor() as cur:
        cur.executemany(query, payload)


def upsert_qwen_embeddings(
    conn,
    rows: List[Tuple[str, str]],
) -> None:
    query = """
        INSERT INTO namuwiki_document_embeddings_qwen (
            doc_hash,
            embedding,
            updated_at
        ) VALUES (
            %s,
            %s,
            NOW()
        )
        ON CONFLICT (doc_hash) DO UPDATE SET
            embedding = EXCLUDED.embedding,
            updated_at = NOW()
    """

    with conn.cursor() as cur:
        cur.executemany(query, rows)


def resolve_dtype(torch_module, value: str, device: str):
    normalized = value.strip().lower()

    if normalized == "auto":
        if device == "cuda":
            return torch_module.bfloat16
        if device == "mps":
            return torch_module.float16
        return torch_module.float32

    if normalized == "float16":
        return (
            torch_module.float16 if device in {"cuda", "mps"} else torch_module.float32
        )

    if normalized == "bfloat16":
        return torch_module.bfloat16 if device == "cuda" else torch_module.float32

    return torch_module.float32


def chunk_texts(texts: List[str], chunk_size: int) -> Iterable[List[str]]:
    if chunk_size < 1:
        raise ValueError("QWEN_BATCH_SIZE must be >= 1")

    for start in range(0, len(texts), chunk_size):
        yield texts[start : start + chunk_size]


def embed_texts(
    torch_module,
    tokenizer,
    model,
    texts: List[str],
    max_tokens: int,
    target_dim: int,
) -> List[List[float]]:
    if not texts:
        return []

    inputs = tokenizer(
        texts,
        padding=True,
        truncation=True,
        max_length=max_tokens,
        return_tensors="pt",
    )

    model_device = next(model.parameters()).device
    inputs = {key: value.to(model_device) for key, value in inputs.items()}

    with torch_module.inference_mode():
        outputs = model(**inputs, output_hidden_states=True, return_dict=True)

    if hasattr(outputs, "last_hidden_state"):
        hidden = outputs.last_hidden_state
    elif hasattr(outputs, "hidden_states") and outputs.hidden_states:
        hidden = outputs.hidden_states[-1]
    elif isinstance(outputs, tuple) and len(outputs) > 0:
        hidden = outputs[0]
    else:
        raise ValueError("Qwen model output does not contain token embeddings")

    attention_mask = inputs["attention_mask"].unsqueeze(-1).to(hidden.dtype)
    pooled = (hidden * attention_mask).sum(dim=1) / attention_mask.sum(dim=1).clamp(
        min=1e-9
    )
    pooled = torch_module.nan_to_num(pooled, nan=0.0, posinf=0.0, neginf=0.0)
    normalized = torch_module.nn.functional.normalize(pooled, p=2, dim=1, eps=1e-12)
    normalized = torch_module.nan_to_num(normalized, nan=0.0, posinf=0.0, neginf=0.0)
    vectors = normalized[:, :target_dim].detach().cpu().float().tolist()

    del outputs
    del hidden
    del attention_mask
    del pooled
    del normalized
    del inputs

    return vectors


def is_memory_error(exception: RuntimeError) -> bool:
    message = str(exception).lower()
    keys = [
        "out of memory",
        "mps backend out of memory",
        "cuda out of memory",
        "oom",
    ]
    return any(key in message for key in keys)


def clear_device_cache(torch_module, device: str) -> None:
    if device == "cuda" and torch_module.cuda.is_available():
        torch_module.cuda.empty_cache()
    elif device == "mps" and hasattr(torch_module, "mps"):
        torch_module.mps.empty_cache()

    gc.collect()


def embed_texts_in_batches(
    torch_module,
    tokenizer,
    model,
    texts: List[str],
    max_tokens: int,
    target_dim: int,
    batch_size: int,
    min_tokens: int,
    min_batch_size: int,
    device: str,
    clear_cache_every_batch: bool,
) -> List[List[float]]:
    vectors: List[List[float]] = []

    if min_batch_size < 1:
        raise ValueError("QWEN_MIN_BATCH_SIZE must be >= 1")
    if min_tokens < 1:
        raise ValueError("QWEN_MIN_TOKENS must be >= 1")

    queue = deque((batch, max_tokens) for batch in chunk_texts(texts, batch_size))

    while queue:
        text_batch, current_tokens = queue.popleft()

        try:
            vectors.extend(
                embed_texts(
                    torch_module,
                    tokenizer,
                    model,
                    text_batch,
                    max_tokens=current_tokens,
                    target_dim=target_dim,
                )
            )

            if clear_cache_every_batch:
                clear_device_cache(torch_module, device)
        except RuntimeError as error:
            if not is_memory_error(error):
                raise

            clear_device_cache(torch_module, device)

            if len(text_batch) > min_batch_size:
                midpoint = max(min_batch_size, len(text_batch) // 2)
                first_half = text_batch[:midpoint]
                second_half = text_batch[midpoint:]
                if second_half:
                    queue.appendleft((second_half, current_tokens))
                queue.appendleft((first_half, current_tokens))
                continue

            if current_tokens > min_tokens:
                reduced_tokens = max(min_tokens, current_tokens // 2)
                if reduced_tokens == current_tokens and current_tokens > min_tokens:
                    reduced_tokens = current_tokens - 1
                queue.appendleft((text_batch, reduced_tokens))
                continue

            raise RuntimeError(
                "Out of memory while embedding even at minimum batch/tokens. "
                "Try lower QWEN_MIN_TOKENS, lower MAX_TEXT_CHARS, or use a smaller model."
            ) from error

    return vectors


def main() -> None:
    load_dotenv(DB_ROOT_DIR / ".env")
    load_dotenv(PROJECT_ROOT_DIR / ".env")
    pq_module, psycopg, torch, transformers = load_dependencies()

    parquet_url = os.getenv("HF_PARQUET_URL", DEFAULT_HF_PARQUET_URL)
    parquet_path = Path(
        os.getenv("LOCAL_PARQUET_PATH", str(DEFAULT_LOCAL_PARQUET_PATH))
    )
    qwen_model_name = os.getenv("QWEN_EMBED_MODEL", DEFAULT_QWEN_MODEL)
    qwen_expected_dim = env_int("QWEN_EMBED_DIM", DEFAULT_QWEN_EMBED_DIM)
    batch_size = env_int("QWEN_BATCH_SIZE", 2)
    min_batch_size = env_int("QWEN_MIN_BATCH_SIZE", 1)
    parquet_batch_rows = env_int("PARQUET_BATCH_ROWS", 256)
    db_commit_rows = env_int("DB_COMMIT_ROWS", 512)
    max_rows = env_optional_int("MAX_ROWS")
    max_text_chars = env_int("MAX_TEXT_CHARS", 4000)
    max_tokens = env_int("QWEN_MAX_TOKENS", 2048)
    min_tokens = env_int("QWEN_MIN_TOKENS", 256)
    ts_config_requested = os.getenv("TS_CONFIG", "korean")
    default_device = resolve_default_device(torch)
    device = os.getenv("QWEN_DEVICE", default_device)
    dtype = resolve_dtype(torch, os.getenv("QWEN_DTYPE", "auto"), device)
    progress_width = env_int("QWEN_PROGRESS_WIDTH", 30)
    progress_render_every = max(1, env_int("QWEN_PROGRESS_EVERY", 32))
    skip_init_sql = env_bool("SKIP_INIT_SQL", False)
    low_cpu_mem_usage = env_bool("QWEN_LOW_CPU_MEM_USAGE", True)
    clear_cache_every_batch = env_bool("QWEN_CLEAR_CACHE_EVERY_BATCH", device == "mps")
    mps_memory_fraction = env_optional_float("QWEN_MPS_MEMORY_FRACTION")
    device_map = (os.getenv("QWEN_DEVICE_MAP") or "").strip()

    if batch_size < 1:
        raise ValueError("QWEN_BATCH_SIZE must be >= 1")
    if min_batch_size < 1:
        raise ValueError("QWEN_MIN_BATCH_SIZE must be >= 1")
    if parquet_batch_rows < 1:
        raise ValueError("PARQUET_BATCH_ROWS must be >= 1")
    if db_commit_rows < 1:
        raise ValueError("DB_COMMIT_ROWS must be >= 1")
    if max_tokens < 1:
        raise ValueError("QWEN_MAX_TOKENS must be >= 1")
    if min_tokens < 1:
        raise ValueError("QWEN_MIN_TOKENS must be >= 1")
    if min_tokens > max_tokens:
        raise ValueError("QWEN_MIN_TOKENS must be <= QWEN_MAX_TOKENS")
    if min_batch_size > batch_size:
        raise ValueError("QWEN_MIN_BATCH_SIZE must be <= QWEN_BATCH_SIZE")
    if mps_memory_fraction is not None and not (0.0 < mps_memory_fraction <= 1.0):
        raise ValueError("QWEN_MPS_MEMORY_FRACTION must be in (0, 1]")

    local_parquet = ensure_parquet_file(parquet_url, parquet_path)
    db_params = get_db_params()

    inserted_or_updated = 0
    sanitized_vector_rows = 0
    vector_dim: Optional[int] = None
    embedding_ms_total = 0.0
    rows_processed = 0
    rows_target = 0

    with psycopg.connect(**db_params) as conn:
        if not skip_init_sql:
            print("Initializing schema and extensions ...")
            run_init_sql(conn)
        ts_config = resolve_ts_config(conn, ts_config_requested)
        print(f"Using text search config: {ts_config}")

        print("Loading Qwen embedding model ...")
        tokenizer = transformers.AutoTokenizer.from_pretrained(
            qwen_model_name, trust_remote_code=True
        )

        if tokenizer.pad_token is None and tokenizer.eos_token is not None:
            tokenizer.pad_token = tokenizer.eos_token

        model_loader = getattr(
            transformers,
            "AutoModelForImageTextToText",
            transformers.AutoModel,
        )
        model_load_kwargs = {
            "trust_remote_code": True,
            "dtype": dtype,
        }
        if low_cpu_mem_usage:
            model_load_kwargs["low_cpu_mem_usage"] = True
        if device_map:
            model_load_kwargs["device_map"] = device_map

        model = model_loader.from_pretrained(
            qwen_model_name,
            **model_load_kwargs,
        )

        if not device_map:
            model.to(device)

        model.eval()

        if (
            device == "mps"
            and mps_memory_fraction is not None
            and hasattr(torch, "mps")
        ):
            torch.mps.set_per_process_memory_fraction(mps_memory_fraction)

        print(
            f"Embedding config: device={device}, dtype={dtype}, "
            f"qwen_batch_size={batch_size}, db_commit_rows={db_commit_rows}"
        )
        print(
            "Range config: "
            f"MAX_ROWS={'all' if max_rows is None else max_rows}, "
            "DB_COMMIT_ROWS is flush size only"
        )
        print(
            f"Memory guard: min_batch={min_batch_size}, min_tokens={min_tokens}, "
            f"clear_cache_every_batch={clear_cache_every_batch}, "
            f"mps_memory_fraction={mps_memory_fraction if mps_memory_fraction is not None else 'default'}"
        )

        parquet_total_rows = pq_module.ParquetFile(local_parquet).metadata.num_rows
        rows_target = parquet_total_rows
        if max_rows is not None:
            rows_target = min(rows_target, max_rows)

        print(f"Target rows: {rows_target}")
        if rows_target > 0:
            render_progress_bar(
                "Qwen progress",
                0,
                rows_target,
                progress_width,
            )
        else:
            print("Qwen progress: no rows assigned.")

        docs_buffer: List[Tuple[Optional[str], str, Optional[str], Optional[str]]] = []
        for title, text, contributors, namespace in parquet_rows(
            pq_module,
            local_parquet,
            batch_rows=parquet_batch_rows,
            max_rows=max_rows,
        ):
            rows_processed += 1
            if rows_target > 0 and (
                rows_processed % progress_render_every == 0
                or rows_processed == rows_target
            ):
                render_progress_bar(
                    "Qwen progress",
                    rows_processed,
                    rows_target,
                    progress_width,
                )

            if not text:
                continue

            docs_buffer.append((title, text, contributors, namespace))

            if len(docs_buffer) < db_commit_rows:
                continue

            started = time.perf_counter()
            texts_for_embedding = [
                normalize_for_embedding(item[1], max_text_chars) for item in docs_buffer
            ]
            vectors = embed_texts_in_batches(
                torch,
                tokenizer,
                model,
                texts_for_embedding,
                max_tokens=max_tokens,
                target_dim=qwen_expected_dim,
                batch_size=batch_size,
                min_tokens=min_tokens,
                min_batch_size=min_batch_size,
                device=device,
                clear_cache_every_batch=clear_cache_every_batch,
            )
            embedding_ms_total += (time.perf_counter() - started) * 1000

            document_rows: List[
                Tuple[str, Optional[str], str, Optional[str], Optional[str]]
            ] = []
            embedding_rows: List[Tuple[str, str]] = []
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

                if vector_dim != qwen_expected_dim:
                    raise ValueError(
                        f"Qwen dimension mismatch: expected {qwen_expected_dim}, got {vector_dim}. "
                        "Update QWEN_EMBED_DIM or model choice."
                    )

                doc_hash = hashlib.sha256(
                    f"{doc_title or ''}\n{doc_content}".encode("utf-8")
                ).hexdigest()

                document_rows.append(
                    (
                        doc_hash,
                        doc_title,
                        doc_content,
                        doc_contributors,
                        doc_namespace,
                    )
                )
                sanitized_vector, had_invalid = sanitize_vector_values(
                    vector,
                    qwen_expected_dim,
                )
                if had_invalid:
                    sanitized_vector_rows += 1

                embedding_rows.append((doc_hash, to_vector_literal(sanitized_vector)))

            upsert_documents(conn, ts_config, document_rows)
            upsert_qwen_embeddings(conn, embedding_rows)
            conn.commit()

            inserted_or_updated += len(embedding_rows)
            docs_buffer = []

        if docs_buffer:
            started = time.perf_counter()
            texts_for_embedding = [
                normalize_for_embedding(item[1], max_text_chars) for item in docs_buffer
            ]
            vectors = embed_texts_in_batches(
                torch,
                tokenizer,
                model,
                texts_for_embedding,
                max_tokens=max_tokens,
                target_dim=qwen_expected_dim,
                batch_size=batch_size,
                min_tokens=min_tokens,
                min_batch_size=min_batch_size,
                device=device,
                clear_cache_every_batch=clear_cache_every_batch,
            )
            embedding_ms_total += (time.perf_counter() - started) * 1000

            document_rows = []
            embedding_rows = []
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

                if vector_dim != qwen_expected_dim:
                    raise ValueError(
                        f"Qwen dimension mismatch: expected {qwen_expected_dim}, got {vector_dim}. "
                        "Update QWEN_EMBED_DIM or model choice."
                    )

                doc_hash = hashlib.sha256(
                    f"{doc_title or ''}\n{doc_content}".encode("utf-8")
                ).hexdigest()

                document_rows.append(
                    (
                        doc_hash,
                        doc_title,
                        doc_content,
                        doc_contributors,
                        doc_namespace,
                    )
                )
                sanitized_vector, had_invalid = sanitize_vector_values(
                    vector,
                    qwen_expected_dim,
                )
                if had_invalid:
                    sanitized_vector_rows += 1

                embedding_rows.append((doc_hash, to_vector_literal(sanitized_vector)))

            upsert_documents(conn, ts_config, document_rows)
            upsert_qwen_embeddings(conn, embedding_rows)
            conn.commit()

            inserted_or_updated += len(embedding_rows)

        if rows_target > 0:
            render_progress_bar(
                "Qwen progress",
                rows_processed,
                rows_target,
                progress_width,
                is_complete=True,
            )

    per_doc_ms = (
        round(embedding_ms_total / inserted_or_updated, 3) if inserted_or_updated else 0
    )
    print(f"Done. Total Qwen upserted rows: {inserted_or_updated}")
    print(f"Rows processed: {rows_processed}/{rows_target}")
    print(f"Qwen embedding dim: {vector_dim}")
    print(f"Avg embedding time per doc (ms): {per_doc_ms}")
    print(f"Sanitized vector rows (NaN/Inf -> 0): {sanitized_vector_rows}")


if __name__ == "__main__":
    main()
