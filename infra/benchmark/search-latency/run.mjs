#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')
const serverBaseUrl = process.env.SEARCH_BENCH_SERVER_URL ?? 'http://localhost:3000'
const outputDir = path.resolve(rootDir, '.artifacts/search-latency')
const queryFilePath =
  process.env.SEARCH_BENCH_QUERY_FILE ??
  path.resolve(rootDir, 'infra/benchmark/search-latency/queries.json')

const requestBody = {
  offset: 0,
  limit: 10,
  mode: 'hnsw',
  bm25Enabled: true,
  hybridRatio: 53,
  embeddingModel: 'qwen3'
}

const queries = JSON.parse(await readFile(queryFilePath, 'utf8'))

if (!Array.isArray(queries) || queries.some((query) => typeof query !== 'string')) {
  throw new Error(`Invalid query file: ${queryFilePath}`)
}

const results = []

for (const query of queries) {
  const response = await fetch(`${serverBaseUrl}/api/search/hybrid`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      ...requestBody,
      query
    })
  })
  const payload = await response.json()
  const data = payload.data?.[0]

  results.push({
    query,
    success: payload.success === true,
    tookMs: payload.meta?.tookMs ?? null,
    total: payload.meta?.total ?? null,
    topTitle: data?.items?.[0]?.title ?? null,
    fallbackUsed: typeof data?.learning?.generatedSql === 'string'
      ? data.learning.generatedSql.includes('fallbackStrategy: bm25-only') ||
        data.learning.generatedSql.includes('fallback: lexical-like')
      : false,
    executionPlanNodeType: data?.learning?.executionPlan?.['Node Type'] ?? null,
    pipelineTimings: data?.learning?.pipelineTimings ?? null
  })
}

const successfulTimings = results
  .map((result) => result.tookMs)
  .filter((value) => typeof value === 'number')
  .sort((left, right) => left - right)

const percentile = (values, ratio) => {
  if (values.length === 0) return null
  const index = Math.min(values.length - 1, Math.floor(values.length * ratio))
  return values[index]
}

const summary = {
  totalQueries: results.length,
  successfulQueries: results.filter((result) => result.success).length,
  p50TookMs: percentile(successfulTimings, 0.5),
  p95TookMs: percentile(successfulTimings, 0.95),
  fallbackRate: results.length === 0
    ? 0
    : Number((results.filter((result) => result.fallbackUsed).length / results.length).toFixed(3))
}

await mkdir(outputDir, { recursive: true })

const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
const outputPath = path.resolve(outputDir, `search-latency-${timestamp}.json`)

await writeFile(
  outputPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      serverBaseUrl,
      requestBody,
      summary,
      results
    },
    null,
    2
  )
)

console.log(`Search latency report written to ${outputPath}`)
