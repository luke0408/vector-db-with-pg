# Hybrid Search BM25 Reactivation (2026-03-02)

## 1) 변경 배경

- 기존 hybrid 검색 경로가 `ranking: vector-distance-only`로 고정되어 `bm25Enabled` 옵션이 실제 랭킹에 반영되지 않았다.
- 사용자 요청에 따라 BM25를 다시 랭킹 계산에 적용해, lexical signal과 vector signal을 함께 사용하도록 복구했다.

## 2) 변경 파일 목록

- `apps/server/src/app.service.ts`
- `apps/server/test/app.spec.ts`
- `apps/server/src/app.controller.ts`
- `apps/web/src/lib/search-api.ts`

## 3) 동작 변경 요약 (사용자 영향)

- `bm25Enabled=true`일 때:
  - ANN 후보 집합 내부에서 `ts_rank_cd(...) AS bm25_score`를 계산한다.
  - 최종 점수는 `vectorScore * semanticWeight + bm25ScoreNormalized * keywordWeight`로 계산한다.
  - `hybridRatio`가 실제 가중치로 반영된다.
  - `learning.generatedSql` 메타에 `ranking: vector+bm25-hybrid`가 기록된다.
- `bm25Enabled=false`일 때:
  - 기존과 동일하게 vector distance 기반 점수만 사용한다.
  - `learning.generatedSql` 메타에 `ranking: vector-distance-only`가 기록된다.

## 4) 검증 방법 (테스트/수동 검증)

- 자동 검증:
  - `npm run test:server`
  - `npm run typecheck:server`
  - `npm run build:server`
- 수동 검증:
  - 동일 질의(`가장 좋은 CPU`)에 대해 `bm25Enabled=true/false`를 각각 호출해 점수/메타 비교
  - 결과 예시:
    - `bm25Enabled=true` -> `score: 0.516`, `ranking: vector+bm25-hybrid`
    - `bm25Enabled=false` -> `score: 1`, `ranking: vector-distance-only`

## 5) 롤백 또는 안전장치

- 즉시 롤백:
  - 클라이언트 또는 API 호출에서 `bm25Enabled=false`로 설정하면 vector-only 경로를 강제할 수 있다.
- 코드 롤백:
  - `apps/server/src/app.service.ts`의 hybrid ORDER BY/score 계산을 vector-only 분기로 되돌리면 된다.
