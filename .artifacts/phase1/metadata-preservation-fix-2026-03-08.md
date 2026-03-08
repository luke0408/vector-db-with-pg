# Metadata Preservation Fix Report

Date: 2026-03-08

## Bug
`POST /api/admin/tables/register-existing` overwrote existing managed-table metadata when optional fields were omitted from the request. In practice, partial calls could erase values like:
- `docHashColumn`
- `description`
- existing column mappings and dimensions

## Fix
- Added request-merge helper:
  - `/Users/SunKyuChoi/Projects/vector-db-with-pg/apps/server/src/admin/admin-registration.ts`
- Updated admin service to merge partial register-existing requests with existing stored metadata before sanitizing/upserting:
  - `/Users/SunKyuChoi/Projects/vector-db-with-pg/apps/server/src/admin/admin.service.ts`
- Kept explicit nullable behavior for `docHashColumn: null` while preserving omitted values.

## Tests
- Added regression unit tests:
  - `/Users/SunKyuChoi/Projects/vector-db-with-pg/apps/server/test/admin-registration.spec.ts`
- Validation passed:
  - `npm run test:server`
  - `npm run typecheck:server`
  - `npm run build:server`

## Live verification
Verified against localhost admin API on port 3004:
1. POST with explicit `docHashColumn` + `description`
2. POST with partial payload omitting those fields
3. GET `/api/admin/tables`

Result: `docHashColumn` and `description` remained intact after the partial update.
