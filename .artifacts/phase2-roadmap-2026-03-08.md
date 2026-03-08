# Remaining Phase Roadmap After Phase 1

- Phase 1 ✅ committed at `c94884c`
  - foundation schema
  - managed-table registry
  - admin read APIs
  - minimal admin UI

## Phase 2
- backend admin write path
- BM25 settings update API
- document CUD API with task logging
- SSE chunked indexing loop for queued tasks
- Phase 2 report + commit

## Phase 3
- admin UI expansion
- BM25 settings editor
- chunk size persistence
- SSE progress and cancel controls
- Phase 3 report + commit

## Phase 4
- search cutover to managed-table aware path
- managed BM25 support-table integration in ranking
- table-aware search UI / API cleanup
- report + commit

## Expected follow-up risks
- sync/async migration behavior on existing namuwiki scale
- dynamic SQL safety and metadata validation breadth
- search quality regression during BM25 cutover
