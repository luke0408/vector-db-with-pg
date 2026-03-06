# Qwen3-VL-Embedding-8B vs MiniLM Embedding Comparison (2026-03-03)

## 1) Background

- Goal: add a Qwen embedding ingestion path equivalent to `infra/db/scripts/ingest_namuwiki.py` and compare stored embedding outputs against current MiniLM embeddings.
- Existing baseline model: `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` (stored in `namuwiki_documents.embedding`).

## 2) Implemented Changes

- Added Qwen ingestion scripts:
  - `infra/db/scripts/ingest_namuwiki_qwen.py`
- Added Qwen storage table and indexes:
  - `infra/db/sql/init.sql`
  - table: `namuwiki_document_embeddings_qwen`
- Added embedding comparison script:
  - `infra/db/scripts/compare_embedding_models.py`
- Updated dependencies:
  - `infra/db/requirements.txt`
- Updated usage docs:
  - `README.md`

## 3) Important Constraint and Design Decision

- pgvector HNSW/IVFFlat index creation fails for `vector(4096)` in this environment.
- To keep indexed ANN comparison practical, Qwen vectors are stored as `VECTOR(1024)` by truncating normalized model outputs to 1024 dims before DB insert.

## 4) How to Run (Reproducible)

### 4.1 Schema apply

```bash
docker exec -i pgvector psql -U luke -d luke < infra/db/sql/init.sql
```

### 4.2 Qwen ingestion (parallel shard mode)

```bash
# worker 0
QWEN_SHARD_COUNT=2 QWEN_SHARD_INDEX=0 SKIP_INIT_SQL=false python infra/db/scripts/ingest_namuwiki_qwen.py

# worker 1
QWEN_SHARD_COUNT=2 QWEN_SHARD_INDEX=1 SKIP_INIT_SQL=true python infra/db/scripts/ingest_namuwiki_qwen.py
```

### 4.3 Embedding output comparison

```bash
python infra/db/scripts/compare_embedding_models.py --sample-size 200 --query-count 30 --neighbor-k 10 --label minilm-vs-qwen
```

## 5) Current Measurement Snapshot

- Output artifact:
  - `.artifacts/search-quality/embedding-model-comparison-minilm-vs-qwen-2026-03-03.json`
- Current DB coverage at run time:
  - `documents_total`: 867025
  - `documents_with_minilm`: 867025
  - `documents_with_qwen`: 0
- Script status:
  - `insufficient_qwen_embeddings`

Interpretation:

- Comparison execution path is validated.
- Full A/B metrics require successful Qwen ingestion rows.

## 6) Why Differences Are Expected (Analysis)

Once Qwen rows are present, expected gaps typically come from:

1. Embedding capacity: MiniLM(384) vs Qwen(1024 stored from larger latent representation) alters neighborhood structure.
2. Model objective mismatch: multilingual sentence-transformer baseline vs instruction/multimodal-oriented Qwen embedding behavior.
3. Index behavior in higher dimensions: ANN recall/latency characteristics shift with dimension and vector distribution.
4. Inference cost: Qwen encoding time per document is much higher, affecting ingestion throughput and refresh cost.

## 7) Validation and Safety

- Python syntax checks completed for new scripts.
- Full repository checks completed:
  - `npm run test`
  - `npm run typecheck`
  - `npm run build`
- Rollback path:
  - Existing MiniLM path remains unchanged.
  - Qwen data isolated in `namuwiki_document_embeddings_qwen`.
