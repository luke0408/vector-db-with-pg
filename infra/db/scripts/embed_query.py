#!/usr/bin/env python3
import argparse
import importlib
import json
import os
import sys
from pathlib import Path
from typing import Any, Sequence

from ingest_namuwiki import (
    DEFAULT_EMBED_MODEL,
    normalize_for_embedding as normalize_base_text,
    to_vector_literal,
)
from ingest_namuwiki_qwen import (
    DEFAULT_QWEN_EMBED_DIM,
    DEFAULT_QWEN_MODEL,
    embed_texts,
    normalize_for_embedding as normalize_qwen_text,
    resolve_default_device,
    resolve_dtype,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a query embedding literal")
    parser.add_argument("--model", choices=["base", "qwen3"], required=True)
    parser.add_argument("--text")
    parser.add_argument("--serve", action="store_true")
    return parser.parse_args()


def resolve_snapshot_path(model_id: str, override_env_name: str) -> str:
    override = os.getenv(override_env_name, "").strip()

    if override:
        override_path = Path(override).expanduser()
        if override_path.exists():
            return str(override_path)

    hub_root = Path(
        os.getenv("HF_HOME", str(Path.home() / ".cache" / "huggingface"))
    ) / "hub"
    repo_dir = hub_root / f"models--{model_id.replace('/', '--')}"
    snapshots_dir = repo_dir / "snapshots"
    refs_main = repo_dir / "refs" / "main"

    if refs_main.exists():
        snapshot_id = refs_main.read_text(encoding="utf-8").strip()
        snapshot_path = snapshots_dir / snapshot_id
        if snapshot_path.exists():
            return str(snapshot_path)

    if snapshots_dir.exists():
        snapshots = sorted(
            (path for path in snapshots_dir.iterdir() if path.is_dir()),
            key=lambda path: path.name,
        )
        if snapshots:
            return str(snapshots[-1])

    return model_id


def load_base_resources() -> dict[str, Any]:
    sentence_transformers = importlib.import_module("sentence_transformers")
    model_id = os.getenv("EMBED_MODEL", DEFAULT_EMBED_MODEL)
    model_path = resolve_snapshot_path(model_id, "BASE_EMBED_MODEL_PATH")
    max_chars = int(
        os.getenv("QUERY_EMBED_MAX_TEXT_CHARS", os.getenv("MAX_TEXT_CHARS", "4000"))
    )
    embedder = sentence_transformers.SentenceTransformer(
        model_path,
        local_files_only=True,
    )
    return {
        "embedder": embedder,
        "max_chars": max_chars,
    }


def load_qwen_resources() -> dict[str, Any]:
    torch = importlib.import_module("torch")
    transformers = importlib.import_module("transformers")

    model_id = os.getenv("QWEN_EMBED_MODEL", DEFAULT_QWEN_MODEL)
    model_path = resolve_snapshot_path(model_id, "QWEN_EMBED_MODEL_PATH")
    target_dim = int(os.getenv("QWEN_EMBED_DIM", str(DEFAULT_QWEN_EMBED_DIM)))
    max_chars = int(
        os.getenv("QUERY_EMBED_MAX_TEXT_CHARS", os.getenv("MAX_TEXT_CHARS", "4000"))
    )
    max_tokens = int(os.getenv("QWEN_QUERY_MAX_TOKENS", "512"))
    default_device = resolve_default_device(torch)
    device = os.getenv("QWEN_QUERY_DEVICE", default_device)
    dtype = resolve_dtype(torch, os.getenv("QWEN_QUERY_DTYPE", "auto"), device)

    tokenizer = transformers.AutoTokenizer.from_pretrained(
        model_path,
        trust_remote_code=True,
        local_files_only=True,
    )

    if tokenizer.pad_token is None and tokenizer.eos_token is not None:
        tokenizer.pad_token = tokenizer.eos_token

    model_loader = getattr(
        transformers,
        "AutoModelForImageTextToText",
        transformers.AutoModel,
    )
    model = model_loader.from_pretrained(
        model_path,
        trust_remote_code=True,
        local_files_only=True,
        dtype=dtype,
        low_cpu_mem_usage=True,
    )
    model.to(device)
    model.eval()

    return {
        "torch": torch,
        "tokenizer": tokenizer,
        "model": model,
        "max_chars": max_chars,
        "max_tokens": max_tokens,
        "target_dim": target_dim,
    }


def embed_base_query(text: str, resources: dict[str, Any]) -> Sequence[float]:
    vector = resources["embedder"].encode(
        [normalize_base_text(text, resources["max_chars"])],
        normalize_embeddings=True,
        show_progress_bar=False,
    )[0]
    return vector.tolist() if hasattr(vector, "tolist") else vector


def embed_qwen_query(text: str, resources: dict[str, Any]) -> Sequence[float]:
    vectors = embed_texts(
        resources["torch"],
        resources["tokenizer"],
        resources["model"],
        [normalize_qwen_text(text, resources["max_chars"])],
        max_tokens=resources["max_tokens"],
        target_dim=resources["target_dim"],
    )
    return vectors[0]


def load_resources(model_name: str) -> dict[str, Any]:
    if model_name == "base":
        return load_base_resources()
    return load_qwen_resources()


def embed_query(text: str, model_name: str, resources: dict[str, Any]) -> Sequence[float]:
    if model_name == "base":
        return embed_base_query(text, resources)
    return embed_qwen_query(text, resources)


def serve(model_name: str) -> None:
    resources = load_resources(model_name)
    print(
        json.dumps(
            {
                "event": "ready",
                "model": model_name,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )

    for raw_line in sys.stdin:
        line = raw_line.strip()

        if not line:
            continue

        try:
            payload = json.loads(line)
            request_id = payload.get("id")
            text = str(payload.get("text", ""))

            vector = embed_query(text, model_name, resources)
            response = {
                "id": request_id,
                "vector_literal": to_vector_literal(vector),
                "dimension": len(vector),
            }
        except Exception as error:  # pragma: no cover - surfaced to Node caller
            response = {
                "id": payload.get("id") if isinstance(payload, dict) else None,
                "error": str(error),
            }

        print(json.dumps(response, ensure_ascii=False), flush=True)


def main() -> None:
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

    args = parse_args()

    if args.serve:
        serve(args.model)
        return

    if not args.text:
        raise SystemExit("--text is required unless --serve is used")

    try:
        resources = load_resources(args.model)
        vector = embed_query(args.text, args.model, resources)
        print(
            json.dumps(
                {
                    "vector_literal": to_vector_literal(vector),
                    "dimension": len(vector),
                },
                ensure_ascii=False,
            )
        )
    except Exception as error:  # pragma: no cover - surfaced to Node caller
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
