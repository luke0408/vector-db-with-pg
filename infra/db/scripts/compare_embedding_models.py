#!/usr/bin/env python3

import argparse
import json
import math
import random
import statistics
import subprocess
from datetime import datetime
from pathlib import Path


def parse_vector_literal(value: str) -> list[float]:
    stripped = value.strip()

    if not (stripped.startswith("[") and stripped.endswith("]")):
        raise ValueError("Invalid vector literal format")

    inner = stripped[1:-1]
    if not inner:
        return []

    return [float(token) for token in inner.split(",")]


def run_psql(sql: str, database: str, output_format: str = "json") -> str:
    command = [
        "docker",
        "exec",
        "-i",
        "pgvector",
        "psql",
        "-U",
        "luke",
        "-d",
        database,
        "-At",
        "-c",
        sql,
    ]

    completed = subprocess.run(command, check=True, capture_output=True, text=True)

    if output_format == "json":
        return completed.stdout.strip() or "[]"

    return completed.stdout


def fetch_counts(database: str) -> dict:
    sql = """
    SELECT json_build_object(
      'documents_total', (SELECT COUNT(*) FROM namuwiki_documents),
      'documents_with_minilm', (SELECT COUNT(*) FROM namuwiki_documents WHERE embedding IS NOT NULL),
      'documents_with_qwen', (SELECT COUNT(*) FROM namuwiki_document_embeddings_qwen)
    )::text;
    """
    payload = run_psql(sql, database)
    return json.loads(payload)


def fetch_sample_rows(database: str, sample_size: int) -> list[dict]:
    sql = f"""
    SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json)::text
    FROM (
      SELECT
        d.doc_hash,
        d.title,
        d.embedding::text AS minilm_embedding,
        q.embedding::text AS qwen_embedding
      FROM namuwiki_documents d
      JOIN namuwiki_document_embeddings_qwen q ON q.doc_hash = d.doc_hash
      WHERE d.embedding IS NOT NULL
      ORDER BY random()
      LIMIT {sample_size}
    ) t;
    """
    payload = run_psql(sql, database)
    return json.loads(payload)


def cosine_similarity(left: list[float], right: list[float]) -> float:
    dot = sum(a * b for a, b in zip(left, right))
    left_norm = math.sqrt(sum(a * a for a in left))
    right_norm = math.sqrt(sum(b * b for b in right))

    if left_norm == 0 or right_norm == 0:
        return 0.0

    return dot / (left_norm * right_norm)


def fetch_neighbors(
    database: str,
    table_name: str,
    vector_literal: str,
    exclude_doc_hash: str,
    limit: int,
) -> list[str]:
    sql = f"""
    SELECT COALESCE(json_agg(doc_hash), '[]'::json)::text
    FROM (
      SELECT doc_hash
      FROM {table_name}
      WHERE doc_hash <> '{exclude_doc_hash}'
      ORDER BY embedding <=> '{vector_literal}'::vector
      LIMIT {limit}
    ) t;
    """
    payload = run_psql(sql, database)
    return json.loads(payload)


def compute_norm_summary(vectors: list[list[float]]) -> dict:
    norms = [math.sqrt(sum(value * value for value in vector)) for vector in vectors]

    if not norms:
        return {
            "count": 0,
            "avg_norm": 0,
            "std_norm": 0,
            "min_norm": 0,
            "max_norm": 0,
        }

    return {
        "count": len(norms),
        "avg_norm": round(statistics.mean(norms), 6),
        "std_norm": round(statistics.pstdev(norms), 6),
        "min_norm": round(min(norms), 6),
        "max_norm": round(max(norms), 6),
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Compare MiniLM and Qwen embedding outputs stored in DB"
    )
    parser.add_argument("--database", type=str, default="luke")
    parser.add_argument("--sample-size", type=int, default=200)
    parser.add_argument("--neighbor-k", type=int, default=10)
    parser.add_argument("--query-count", type=int, default=30)
    parser.add_argument("--seed", type=int, default=20260303)
    parser.add_argument("--label", type=str, default="minilm-vs-qwen")
    args = parser.parse_args()

    random.seed(args.seed)
    counts = fetch_counts(args.database)
    sample_rows = fetch_sample_rows(args.database, args.sample_size)

    if not sample_rows:
        comparison = {
            "generated_at": datetime.utcnow().isoformat() + "Z",
            "config": {
                "database": args.database,
                "sample_size": args.sample_size,
                "neighbor_k": args.neighbor_k,
                "query_count": args.query_count,
                "seed": args.seed,
                "label": args.label,
            },
            "coverage": counts,
            "status": "insufficient_qwen_embeddings",
            "message": "Run infra/db/scripts/ingest_namuwiki_qwen.py first, then rerun this comparison script.",
        }
        out_dir = Path(".artifacts/search-quality")
        out_dir.mkdir(parents=True, exist_ok=True)
        output_path = (
            out_dir / f"embedding-model-comparison-{args.label}-2026-03-03.json"
        )
        output_path.write_text(
            json.dumps(comparison, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(json.dumps(comparison, ensure_ascii=False))
        print(str(output_path))
        return

    minilm_vectors = [
        parse_vector_literal(row["minilm_embedding"]) for row in sample_rows
    ]
    qwen_vectors = [parse_vector_literal(row["qwen_embedding"]) for row in sample_rows]

    aligned_cosines = [
        cosine_similarity(minilm_vector, qwen_vector[: len(minilm_vector)])
        for minilm_vector, qwen_vector in zip(minilm_vectors, qwen_vectors)
        if minilm_vector and qwen_vector
    ]

    selected_queries = random.sample(
        sample_rows, min(args.query_count, len(sample_rows))
    )
    overlaps = []
    for row in selected_queries:
        minilm_neighbors = fetch_neighbors(
            args.database,
            "namuwiki_documents",
            row["minilm_embedding"],
            row["doc_hash"],
            args.neighbor_k,
        )
        qwen_neighbors = fetch_neighbors(
            args.database,
            "namuwiki_document_embeddings_qwen",
            row["qwen_embedding"],
            row["doc_hash"],
            args.neighbor_k,
        )

        minilm_set = set(minilm_neighbors)
        qwen_set = set(qwen_neighbors)
        union_size = len(minilm_set | qwen_set)
        overlap_size = len(minilm_set & qwen_set)
        jaccard = (overlap_size / union_size) if union_size else 0
        overlaps.append(jaccard)

    comparison = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "config": {
            "database": args.database,
            "sample_size": args.sample_size,
            "neighbor_k": args.neighbor_k,
            "query_count": args.query_count,
            "seed": args.seed,
            "label": args.label,
        },
        "coverage": counts,
        "dimensions": {
            "minilm_dim": len(minilm_vectors[0])
            if minilm_vectors and minilm_vectors[0]
            else 0,
            "qwen_dim": len(qwen_vectors[0]) if qwen_vectors and qwen_vectors[0] else 0,
        },
        "norm_summary": {
            "minilm": compute_norm_summary(minilm_vectors),
            "qwen": compute_norm_summary(qwen_vectors),
        },
        "aligned_embedding_similarity": {
            "count": len(aligned_cosines),
            "avg_cosine": round(statistics.mean(aligned_cosines), 6)
            if aligned_cosines
            else 0,
            "p95_cosine": round(
                sorted(aligned_cosines)[max(0, int(len(aligned_cosines) * 0.95) - 1)],
                6,
            )
            if aligned_cosines
            else 0,
        },
        "neighbor_overlap": {
            "count": len(overlaps),
            "avg_jaccard_at_k": round(statistics.mean(overlaps), 6) if overlaps else 0,
            "p95_jaccard_at_k": round(
                sorted(overlaps)[max(0, int(len(overlaps) * 0.95) - 1)],
                6,
            )
            if overlaps
            else 0,
        },
    }

    out_dir = Path(".artifacts/search-quality")
    out_dir.mkdir(parents=True, exist_ok=True)
    output_path = out_dir / f"embedding-model-comparison-{args.label}-2026-03-03.json"
    output_path.write_text(
        json.dumps(comparison, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(json.dumps(comparison, ensure_ascii=False))
    print(str(output_path))


if __name__ == "__main__":
    main()
