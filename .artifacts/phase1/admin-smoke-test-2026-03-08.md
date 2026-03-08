# Phase 1 Admin Smoke Test Report

Date: 2026-03-08

## Findings

1. Initial smoke test failure was caused by sandbox-localhost network restrictions, not by a down Postgres instance.
2. After running outside the sandbox, Phase 1 admin read endpoints initially failed because `SELECT to_regclass($1) AS exists` returned a `regclass` type that Prisma could not deserialize.
3. Fix applied: cast to text in `apps/server/src/admin/admin.service.ts`:
   - `SELECT to_regclass($1)::text AS exists`
4. After that fix, live localhost smoke tests succeeded for:
   - `GET /api/admin/languages`
   - `GET /api/admin/tables`
   - `GET /api/admin/bm25/korean/status`
   - `POST /api/admin/tables/register-existing` with `initializeData=false`
5. `POST /api/admin/tables/register-existing` with `initializeData=true` is currently too heavy for synchronous smoke testing:
   - it performs full-table `fts`/`textlen` backfill and BM25 snapshot rebuild for ~59k documents
   - request exceeded 30s curl timeout
   - subsequent POST requests were blocked behind relation locks until the process was terminated

## Additional note
A follow-up issue was observed in the register-existing path:
- posting only `tableName/language/initializeData/makeDefault` overwrote some stored metadata with null/default values (`docHashColumn` became `null`, description became `null`)
- this did not block the smoke test but should be fixed before Phase 2
