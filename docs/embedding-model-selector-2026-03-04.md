# Embedding Model Selector (base vs qwen3)

Date: 2026-03-04

## Background

The project stores two precomputed embedding variants for the same NamuWiki corpus:

- `base` (MiniLM) embeddings in `namuwiki_documents.embedding` (VECTOR(384))
- `qwen3` embeddings in `namuwiki_document_embeddings_qwen.embedding` (VECTOR(1024))

Search was previously hard-wired to use the `base` embedding column for hybrid (ANN) search.

## Change

### API

- Request payload supports `embeddingModel: 'base' | 'qwen3'`.
- Default is `base` when omitted.
- Invalid values return a validation error envelope:
  - `success: false`, `data: []`, `error: 'embeddingModel must be one of base, qwen3'`

### Server behavior

- Hybrid search (`/api/search/hybrid`) branches SQL by `embeddingModel`:
  - `base`: reads `namuwiki_documents d` and uses `d.embedding`
  - `qwen3`: reads `namuwiki_document_embeddings_qwen qe JOIN namuwiki_documents d ...` and uses `qe.embedding`

### Response metadata

- API responses include `meta.embeddingModelUsed` so clients can display the effective model.

### Web UI

- UI adds an embedding model toggle (BASE vs QWEN3) and sends `embeddingModel` in requests.

## Files Changed

- `apps/server/src/app.controller.ts`
- `apps/server/src/app.service.ts`
- `apps/server/src/types/search-contract.ts`
- `apps/server/test/app.spec.ts`
- `apps/web/src/App.tsx`
- `apps/web/src/App.test.tsx`

## Verification

Commands run locally:

```bash
npm run typecheck
npm test
npm run build
```

Result:

- Typecheck: pass
- Tests: pass (web + server)
- Build: pass (web + server)
