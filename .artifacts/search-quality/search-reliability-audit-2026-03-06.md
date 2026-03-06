# Search Reliability Audit (2026-03-06)

## Verdict

Vector/hybrid search quality is not currently reliable.

## Evidence

1. `apps/server/src/app.service.ts` does not embed the user query. It selects one existing document embedding via lexical matching and reuses that vector as `query_vector` for ANN.
2. If no seed embedding is found, the hybrid path returns empty results instead of falling back to lexical/BM25.
3. BM25 reranking is applied only inside the ANN candidate set, so a bad seed cannot be recovered later.
4. Existing artifact `.artifacts/search-quality/random-domain-100-semantic-pipeline-sample-v2-2026-03-02.json` shows:
   - `ok_queries = 18`
   - `low_keyword_coverage_top1_rate = 0.9444`
   - computed top-1 exact title hit rate = `1 / 18 = 0.0556`
5. Live DB state on 2026-03-06:
   - `namuwiki_documents` rows: `59008`
   - non-null `namuwiki_documents.embedding`: `0`
   - `namuwiki_document_embeddings_qwen` rows: `59008`
   - therefore default `embeddingModel=base` hybrid search currently cannot produce seed vectors.
6. Live reproduction:
   - base model query `김승민(래퍼) 관점에서 핵심 개념과 배경을 알려줘` returned no items because no seed embedding was found.
   - qwen3 for the same query returned unrelated top results such as `다니엘`, `느헤미야`, `나니아 연대기`.
   - qwen3 for `포켓몬` returned `닌텐도 포켓몬 동인지 고소 사건` as top-1 instead of the main entity article.

## Likely Root Causes

- lexical-seed-based pseudo query vector
- missing base embeddings in the current DB
- lack of fallback when seed lookup fails
- no live quality regression tests

## Recommended Next Actions

1. Generate real query embeddings at request time (or via a dedicated embedding service).
2. Add lexical/BM25 fallback when seed lookup fails.
3. Add evaluation metrics such as title-hit@k, MRR, and keyword/entity recall on live data.
4. Hide or disable embedding models that have no populated vectors in the current DB.
