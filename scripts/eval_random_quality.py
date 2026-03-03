#!/usr/bin/env python3

import argparse
import json
import random
import subprocess
import time
from pathlib import Path
from urllib import error, request


def fetch_random_titles(sample_size: int, seed: int) -> list[str]:
    random.seed(seed)
    command = [
        "docker",
        "exec",
        "-i",
        "pgvector",
        "psql",
        "-U",
        "luke",
        "-d",
        "luke",
        "-At",
        "-c",
        (
            "SELECT COALESCE(NULLIF(regexp_replace(title, E'\\\\s+', ' ', 'g'), ''), '문서') "
            "FROM namuwiki_documents "
            "WHERE title IS NOT NULL "
            "ORDER BY random() "
            f"LIMIT {sample_size};"
        ),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, check=True)
    titles = [line.strip() for line in completed.stdout.splitlines() if line.strip()]
    if len(titles) < sample_size:
        raise RuntimeError(f"Expected {sample_size} titles, got {len(titles)}")
    return titles


def build_queries(titles: list[str], seed: int) -> list[str]:
    random.seed(seed)
    prefixes = [
        "핵심 개념과 배경을",
        "주요 특징과 차이점을",
        "역사적 맥락과 현재 의미를",
        "실전에서 중요한 포인트를",
        "비교 관점에서 핵심만",
    ]
    bridges = ["중심으로", "관점에서", "기준으로", "위주로"]
    suffixes = ["정리해줘", "설명해줘", "요약해줘", "알려줘"]

    return [
        f"{title} {random.choice(bridges)} {random.choice(prefixes)} {random.choice(suffixes)}"
        for title in titles
    ]


def evaluate_queries(
    queries: list[str],
    endpoint: str,
    timeout_seconds: int,
    mode: str,
    hybrid_ratio: int,
    bm25_enabled: bool,
) -> tuple[dict, list[dict]]:
    rows: list[dict] = []
    for query_text in queries:
        payload = json.dumps(
            {
                "query": query_text,
                "offset": 0,
                "limit": 10,
                "mode": mode,
                "bm25Enabled": bm25_enabled,
                "hybridRatio": hybrid_ratio,
            }
        ).encode("utf-8")
        req = request.Request(
            endpoint,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        started = time.time()
        status = "ok"
        top_title = ""
        top_score = 0.0
        keyword_coverage = 0.0
        normalize_analyze_ms = 0
        seed_lookup_ms = 0
        ann_query_ms = 0
        result_assemble_ms = 0
        pipeline_total_ms = 0
        seed_lookup_attempts = 0
        seed_found = False

        try:
            with request.urlopen(req, timeout=timeout_seconds) as resp:
                response = json.loads(resp.read().decode("utf-8"))
            items = (
                response.get("data", [{}])[0].get("items", [])
                if response.get("data")
                else []
            )
            top = items[0] if items else {}
            top_title = top.get("title", "")
            top_score = top.get("score", 0.0)
            used_keywords = top.get("usedKeywords") or []
            matched_keywords = top.get("matchedKeywords") or []
            learning = response.get("data", [{}])[0].get("learning", {})
            pipeline_timings = learning.get("pipelineTimings") or {}
            normalize_analyze_ms = int(
                pipeline_timings.get("normalizeAndAnalyzeMs", 0) or 0
            )
            seed_lookup_ms = int(pipeline_timings.get("seedLookupMs", 0) or 0)
            ann_query_ms = int(pipeline_timings.get("annQueryMs", 0) or 0)
            result_assemble_ms = int(pipeline_timings.get("resultAssembleMs", 0) or 0)
            pipeline_total_ms = int(pipeline_timings.get("totalPipelineMs", 0) or 0)
            seed_lookup_attempts = int(
                pipeline_timings.get("seedLookupAttempts", 0) or 0
            )
            seed_found = bool(pipeline_timings.get("seedFound", False))
            keyword_coverage = (
                round(len(matched_keywords) / len(used_keywords), 3)
                if used_keywords
                else 0.0
            )
        except error.HTTPError as exc:
            status = f"http_error:{exc.code}"
        except Exception:
            status = "timeout_or_network_error"

        took_ms = int((time.time() - started) * 1000)
        rows.append(
            {
                "query": query_text,
                "status": status,
                "top1_title": top_title,
                "top1_score": top_score,
                "keyword_coverage_top1": keyword_coverage,
                "took_ms_client": took_ms,
                "normalize_analyze_ms": normalize_analyze_ms,
                "seed_lookup_ms": seed_lookup_ms,
                "ann_query_ms": ann_query_ms,
                "result_assemble_ms": result_assemble_ms,
                "pipeline_total_ms": pipeline_total_ms,
                "seed_lookup_attempts": seed_lookup_attempts,
                "seed_found": seed_found,
            }
        )

    ok_rows = [row for row in rows if row["status"] == "ok"]
    durations = sorted(row["took_ms_client"] for row in ok_rows) if ok_rows else []
    pipeline_total_durations = (
        sorted(row["pipeline_total_ms"] for row in ok_rows) if ok_rows else []
    )
    normalize_durations = (
        [row["normalize_analyze_ms"] for row in ok_rows] if ok_rows else []
    )
    seed_lookup_durations = (
        [row["seed_lookup_ms"] for row in ok_rows] if ok_rows else []
    )
    ann_query_durations = [row["ann_query_ms"] for row in ok_rows] if ok_rows else []
    result_assemble_durations = (
        [row["result_assemble_ms"] for row in ok_rows] if ok_rows else []
    )
    p95 = durations[max(0, int(len(durations) * 0.95) - 1)] if durations else 0
    pipeline_p95 = (
        pipeline_total_durations[max(0, int(len(pipeline_total_durations) * 0.95) - 1)]
        if pipeline_total_durations
        else 0
    )
    low_cov_count = sum(1 for row in ok_rows if row["keyword_coverage_top1"] < 0.34)
    seed_not_found_count = sum(1 for row in ok_rows if not row["seed_found"])

    summary = {
        "total_queries": len(rows),
        "ok_queries": len(ok_rows),
        "error_queries": len(rows) - len(ok_rows),
        "avg_took_ms_client": round(sum(durations) / len(durations), 2)
        if durations
        else 0,
        "p95_took_ms_client": p95,
        "avg_pipeline_total_ms": round(
            sum(pipeline_total_durations) / len(pipeline_total_durations), 2
        )
        if pipeline_total_durations
        else 0,
        "p95_pipeline_total_ms": pipeline_p95,
        "avg_normalize_analyze_ms": round(
            sum(normalize_durations) / len(normalize_durations), 2
        )
        if normalize_durations
        else 0,
        "avg_seed_lookup_ms": round(
            sum(seed_lookup_durations) / len(seed_lookup_durations), 2
        )
        if seed_lookup_durations
        else 0,
        "avg_ann_query_ms": round(
            sum(ann_query_durations) / len(ann_query_durations), 2
        )
        if ann_query_durations
        else 0,
        "avg_result_assemble_ms": round(
            sum(result_assemble_durations) / len(result_assemble_durations), 2
        )
        if result_assemble_durations
        else 0,
        "seed_not_found_count": seed_not_found_count,
        "seed_not_found_rate": round(seed_not_found_count / len(ok_rows), 4)
        if ok_rows
        else 0,
        "low_keyword_coverage_top1_count": low_cov_count,
        "low_keyword_coverage_top1_rate": round(low_cov_count / len(ok_rows), 4)
        if ok_rows
        else 0,
    }

    return summary, rows


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Evaluate random domain-agnostic hybrid search quality"
    )
    parser.add_argument("--sample-size", type=int, default=100)
    parser.add_argument("--seed", type=int, default=20260302)
    parser.add_argument("--timeout", type=int, default=15)
    parser.add_argument("--label", type=str, default="baseline")
    parser.add_argument(
        "--endpoint", type=str, default="http://localhost:3000/api/search/hybrid"
    )
    parser.add_argument("--mode", type=str, default="hnsw")
    parser.add_argument("--hybrid-ratio", type=int, default=53)
    parser.add_argument("--bm25-enabled", action="store_true", default=True)
    args = parser.parse_args()

    titles = fetch_random_titles(args.sample_size, args.seed)
    queries = build_queries(titles, args.seed)
    summary, results = evaluate_queries(
        queries,
        endpoint=args.endpoint,
        timeout_seconds=args.timeout,
        mode=args.mode,
        hybrid_ratio=args.hybrid_ratio,
        bm25_enabled=args.bm25_enabled,
    )

    output = {
        "summary": summary,
        "queries": queries,
        "results": results,
        "config": {
            "sample_size": args.sample_size,
            "seed": args.seed,
            "timeout_seconds": args.timeout,
            "endpoint": args.endpoint,
            "mode": args.mode,
            "hybrid_ratio": args.hybrid_ratio,
            "bm25_enabled": args.bm25_enabled,
            "label": args.label,
        },
    }

    out_dir = Path(".artifacts/search-quality")
    out_dir.mkdir(parents=True, exist_ok=True)
    output_path = out_dir / f"random-domain-100-{args.label}-2026-03-02.json"
    output_path.write_text(
        json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(json.dumps(summary, ensure_ascii=False))
    print(str(output_path))


if __name__ == "__main__":
    main()
