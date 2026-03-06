import { Injectable } from '@nestjs/common'
import { PrismaService } from './prisma/prisma.service'
import type { EmbeddingModel } from './types/search-contract'

export interface SearchResult {
  id: number
  title: string
  snippet: string
  score: number
  category?: string
  distance?: number
  tags?: string[]
  matchRate?: number
  usedKeywords?: string[]
  matchedKeywords?: string[]
}

export interface SearchKeywordSignal {
  keyword: string
  weight: number
}

export interface SearchLearningData {
  generatedSql: string
  executionPlan: Record<string, unknown>
  queryExplanation: string
  keywordSignals?: SearchKeywordSignal[]
  pipelineTimings?: SearchPipelineTimings
}

export interface SearchPipelineTimings {
  normalizeAndAnalyzeMs: number
  seedLookupMs: number
  annQueryMs: number
  resultAssembleMs: number
  totalPipelineMs: number
  seedLookupAttempts: number
  seedFound: boolean
}

export interface SearchResponseData {
  items: SearchResult[]
  learning: SearchLearningData
}

export interface SearchQueryOptions {
  offset: number
  limit: number
  embeddingModel?: EmbeddingModel
}

export interface SearchHybridOptions extends SearchQueryOptions {
  mode: 'none' | 'hnsw' | 'ivf'
  bm25Enabled: boolean
  hybridRatio: number
  embeddingModel: EmbeddingModel
}

interface HybridSearchRow {
  id: bigint
  title: string | null
  snippet: string
  namespace: string | null
  contributors: string | null
  vector_distance: number
  bm25_score?: number
}

interface SearchExecutionResult {
  items: SearchResult[]
  total: number
  learning: SearchLearningData
}

@Injectable()
export class AppService {
  private static readonly DOMAIN_ANCHOR_KEYWORDS = ['포켓몬', 'pokemon', 'pokémon'] as const
  private static readonly BROAD_BIAS_KEYWORD_ROOTS = [
    '대한민국',
    '한국',
    '중국',
    '일본',
    '미국',
  ] as const
  private static readonly GENERIC_INTENT_KEYWORDS = [
    '가장',
    '최고',
    '좋',
    '좋은',
    '추천',
    '비교',
    '알려줘',
    '설명해줘',
    '정리해줘',
  ] as const
  private static readonly KOREAN_POSTPOSITION_SUFFIX_PATTERN =
    /(은|는|이|가|을|를|의|에|에서|으로|로|와|과|에게|한테|께|도|만|부터|까지|처럼|보다|랑)$/u

  constructor(private readonly prismaService: PrismaService) {}

  async health() {
    let database = 'up'
    let status = 'ok'

    try {
      await this.prismaService.$queryRawUnsafe('SELECT 1')
    } catch {
      database = 'down'
      status = 'degraded'
    }

    return {
      success: database === 'up',
      data: {
        status,
        service: 'vector-search-server',
        database
      }
    }
  }

  async search(
    query: string,
    options: SearchQueryOptions
  ): Promise<SearchExecutionResult> {
    const normalizedQuery = query.trim().toLowerCase()

    if (!normalizedQuery) {
      return {
        items: [],
        total: 0,
        learning: {
          generatedSql: '-- empty query',
          executionPlan: {},
          queryExplanation: 'No query provided',
          pipelineTimings: {
            normalizeAndAnalyzeMs: 0,
            seedLookupMs: 0,
            annQueryMs: 0,
            resultAssembleMs: 0,
            totalPipelineMs: 0,
            seedLookupAttempts: 0,
            seedFound: false
          }
        }
      }
    }

    const queryPattern = `%${normalizedQuery}%`
    const searchSql = `
      SELECT
        id,
        title,
        LEFT(content, 240) AS snippet,
        namespace,
        contributors,
        CASE
          WHEN LOWER(COALESCE(title, '')) LIKE $1 THEN 0.984
          WHEN LOWER(content) LIKE $2 THEN 0.891
          ELSE 0.723
        END AS score
      FROM namuwiki_documents
      WHERE LOWER(COALESCE(title, '')) LIKE $3
         OR LOWER(content) LIKE $4
      ORDER BY score DESC, id DESC
      LIMIT $5 OFFSET $6
    `

    const countSql = `
      SELECT COUNT(*)::bigint AS total
      FROM namuwiki_documents
      WHERE LOWER(COALESCE(title, '')) LIKE $1
         OR LOWER(content) LIKE $2
    `

    const explainSql = `EXPLAIN (FORMAT JSON) ${searchSql}`

    try {
      const [rawRows, countRows, planRows] = await Promise.all([
        this.prismaService.$queryRawUnsafe(
          searchSql,
          queryPattern,
          queryPattern,
          queryPattern,
          queryPattern,
          options.limit,
          options.offset
        ),
        this.prismaService.$queryRawUnsafe(countSql, queryPattern, queryPattern),
        this.prismaService.$queryRawUnsafe(
          explainSql,
          queryPattern,
          queryPattern,
          queryPattern,
          queryPattern,
          options.limit,
          options.offset
        )
      ])

      const rows = rawRows as Array<{
        id: bigint
        title: string | null
        snippet: string
        namespace: string | null
        contributors: string | null
        score: number
      }>

      const total = Number(
        ((countRows as Array<{ total: bigint }>)[0]?.total ?? BigInt(0)).toString()
      )

      const executionPlan = this.parseExecutionPlan(
        planRows as Array<Record<string, unknown>>
      )

      return {
        items: rows.map((row) => {
          const score = Number(row.score.toFixed(3))
          return {
            id: Number(row.id),
            title: row.title ?? 'Untitled Document',
            snippet: row.snippet,
            score,
            category: row.namespace ?? 'Unknown',
            distance: Number((1 - score).toFixed(4)),
            tags: this.toTags(row.contributors),
            matchRate: Number((score * 100).toFixed(1))
          }
        }),
        total,
        learning: {
          generatedSql: searchSql.trim(),
          executionPlan,
          queryExplanation: this.buildQueryExplanation(executionPlan)
        }
      }
    } catch (error) {
      return this.buildUnavailableResult(error)
    }
  }

  async searchHybrid(
    query: string,
    options: SearchHybridOptions
  ): Promise<SearchExecutionResult> {
    const pipelineStartedAt = Date.now()
    const analyzeStartedAt = Date.now()
    const tsConfig = 'korean'
    const normalizedQuery = query.trim().toLowerCase()

    if (!normalizedQuery) {
      return {
        items: [],
        total: 0,
        learning: {
          generatedSql: '-- empty query',
          executionPlan: {},
          queryExplanation: 'No query provided'
        }
      }
    }

    const queryPattern = `%${normalizedQuery}%`
    const queryTerms = this.extractQueryTerms(normalizedQuery)

    if (queryTerms.length === 0) {
      return {
        items: [],
        total: 0,
        learning: {
          generatedSql: '-- query has no indexable keywords after normalization',
          executionPlan: {},
          queryExplanation: 'Query normalization produced no searchable keywords.',
          pipelineTimings: {
            normalizeAndAnalyzeMs: Date.now() - analyzeStartedAt,
            seedLookupMs: 0,
            annQueryMs: 0,
            resultAssembleMs: 0,
            totalPipelineMs: Date.now() - pipelineStartedAt,
            seedLookupAttempts: 0,
            seedFound: false
          }
        }
      }
    }

    const isShortAmbiguousQuery = queryTerms.length <= 1 && normalizedQuery.length <= 2
    const isLongNaturalLanguageQuery = queryTerms.length >= 4 || normalizedQuery.length >= 16
    const hasDomainAnchor = this.hasDomainAnchor(queryTerms)
    const shouldPreferTitleSeed =
      (queryTerms.length >= 2 && !isLongNaturalLanguageQuery) ||
      (hasDomainAnchor && queryTerms.length >= 2)
    const keywordSignals = this.buildKeywordSignals(queryTerms, isLongNaturalLanguageQuery)
    const weightedKeywords = keywordSignals.map((signal) => signal.keyword)
    const seedQueryExpression = this.buildTsQueryExpression(
      weightedKeywords,
      4,
      '|'
    )
    const rankQueryExpression = this.buildTsQueryExpression(
      weightedKeywords,
      3,
      '&'
    )
    const titleQueryExpression = this.buildTsQueryExpression(
      weightedKeywords,
      isLongNaturalLanguageQuery ? 3 : 2,
      '|'
    )
    const technicalTerms = this.extractTechnicalTerms(queryTerms)
    const technicalSeedExpression = this.buildTsQueryExpression(technicalTerms, 3, '|')
    const technicalRankExpression = this.buildTsQueryExpression(technicalTerms, 2, '&')
    const hasTechnicalFocus = technicalTerms.length > 0 && technicalSeedExpression.length > 0
    const effectiveMode: 'hnsw' | 'ivf' = options.mode === 'ivf' ? 'ivf' : 'hnsw'
    const semanticWeight = options.bm25Enabled ? Number((options.hybridRatio / 100).toFixed(3)) : 1
    const keywordWeight = options.bm25Enabled ? Number((1 - semanticWeight).toFixed(3)) : 0
    const rankingStrategy = options.bm25Enabled ? 'vector+bm25-hybrid' : 'vector-distance-only'
    const normalizeAndAnalyzeMs = Date.now() - analyzeStartedAt

    const sourceJoin = options.embeddingModel === 'qwen3'
      ? 'namuwiki_document_embeddings_qwen qe JOIN namuwiki_documents d ON d.doc_hash = qe.doc_hash'
      : 'namuwiki_documents d'
    const embeddingExpr = options.embeddingModel === 'qwen3' ? 'qe.embedding' : 'd.embedding'

    const seedTitleVectorSql = `
      SELECT ${embeddingExpr}::text AS query_vector
      FROM ${sourceJoin}
      WHERE ${embeddingExpr} IS NOT NULL
        AND to_tsvector('korean', COALESCE(d.title, '')) @@ to_tsquery('korean', $1)
      ORDER BY d.id DESC
      LIMIT 1
    `

    const queryVectorSql = `
      SELECT ${embeddingExpr}::text AS query_vector
      FROM ${sourceJoin}
      WHERE d.search_vector @@ to_tsquery('korean', $1)
        AND ${embeddingExpr} IS NOT NULL
      ORDER BY
        CASE
          WHEN to_tsvector('korean', COALESCE(d.title, '')) @@ to_tsquery('korean', $2) THEN 1
          ELSE 0
        END DESC,
        id DESC
      LIMIT 1
    `

    const queryVectorFastSql = `
      SELECT ${embeddingExpr}::text AS query_vector
      FROM ${sourceJoin}
      WHERE d.search_vector @@ to_tsquery('korean', $1)
        AND ${embeddingExpr} IS NOT NULL
      ORDER BY d.id DESC
      LIMIT 1
    `

    const fallbackVectorSql = `
      SELECT ${embeddingExpr}::text AS query_vector
      FROM ${sourceJoin}
      WHERE ${embeddingExpr} IS NOT NULL
        AND (
          LOWER(COALESCE(d.title, '')) LIKE $1
          OR LOWER(d.content) LIKE $2
        )
      ORDER BY CASE
          WHEN LOWER(COALESCE(d.title, '')) LIKE $1 THEN 2
          WHEN LOWER(d.content) LIKE $2 THEN 1
          ELSE 0
        END DESC,
        d.id DESC
      LIMIT 1
    `

    const distanceOperator = effectiveMode === 'ivf' ? '<#>' : '<=>'
    const poolMultiplier = isShortAmbiguousQuery ? 25 : isLongNaturalLanguageQuery ? 12 : 18
    const candidatePool = Math.max(options.limit + options.offset, 20) * poolMultiplier

    const annSql = `
      WITH ann_candidates AS (
        SELECT
          d.id AS id,
          ${embeddingExpr} ${distanceOperator} $1::vector AS vector_distance
        FROM ${sourceJoin}
        WHERE ${embeddingExpr} IS NOT NULL
        ORDER BY ${embeddingExpr} ${distanceOperator} $1::vector
        LIMIT $2
      ),
      ranked_candidates AS (
        SELECT
          d.id,
          d.title,
          LEFT(d.content, 240) AS snippet,
          d.namespace,
          d.contributors,
          ann_candidates.vector_distance,
          CASE
            WHEN $3::boolean = true
              THEN ts_rank_cd(COALESCE(d.search_vector, ''::tsvector), to_tsquery('${tsConfig}', $4), 32)
            ELSE 0
          END AS bm25_score
        FROM ann_candidates
        JOIN namuwiki_documents d ON d.id = ann_candidates.id
      )
      SELECT
        id,
        title,
        snippet,
        namespace,
        contributors,
        vector_distance,
        bm25_score
      FROM ranked_candidates
      ORDER BY (
        CASE
          WHEN $3::boolean = true
            THEN (
              ($5 * (
                CASE
                  WHEN $7::boolean = true THEN ((-vector_distance + 1) / 2)
                  ELSE (1 - (vector_distance / 2))
                END
              )) + ($6 * (bm25_score / (1 + bm25_score)))
            )
          ELSE (
            CASE
              WHEN $7::boolean = true THEN ((-vector_distance + 1) / 2)
              ELSE (1 - (vector_distance / 2))
            END
          )
        END
      ) DESC,
               id DESC
      LIMIT $8 OFFSET $9
    `

    const annCountSql = `
      WITH ann_candidates AS (
        SELECT d.id AS id
        FROM ${sourceJoin}
        WHERE ${embeddingExpr} IS NOT NULL
        ORDER BY ${embeddingExpr} ${distanceOperator} $1::vector
        LIMIT $2
      )
      SELECT COUNT(*)::bigint AS total
      FROM ann_candidates
    `

    const explainSql = `EXPLAIN (FORMAT JSON) ${annSql}`

    try {
      let queryVector: string | null | undefined
      let seedLookupAttempts = 0
      const seedLookupStartedAt = Date.now()

      if (hasTechnicalFocus) {
        seedLookupAttempts += 1
        const technicalTitleSeedRows = (await this.prismaService.$queryRawUnsafe(
          seedTitleVectorSql,
          technicalSeedExpression
        )) as Array<{ query_vector: string | null }>

        queryVector = technicalTitleSeedRows[0]?.query_vector
      }

      if (!queryVector && (isShortAmbiguousQuery || shouldPreferTitleSeed)) {
        seedLookupAttempts += 1
        const titleSeedRows = (await this.prismaService.$queryRawUnsafe(
          seedTitleVectorSql,
          titleQueryExpression
        )) as Array<{ query_vector: string | null }>

        queryVector = titleSeedRows[0]?.query_vector
      }

      if (!queryVector && hasTechnicalFocus) {
        seedLookupAttempts += 1
        const technicalPrimaryExpression = technicalRankExpression || technicalSeedExpression
        const technicalQueryVectorRows = (await this.prismaService.$queryRawUnsafe(
          queryVectorSql,
          technicalPrimaryExpression,
          technicalSeedExpression
        )) as Array<{ query_vector: string | null }>

        queryVector = technicalQueryVectorRows[0]?.query_vector
      }

      if (!queryVector) {
        seedLookupAttempts += 1
        const queryVectorRows = (isLongNaturalLanguageQuery && !hasDomainAnchor
          ? await this.prismaService.$queryRawUnsafe(queryVectorFastSql, rankQueryExpression)
          : await this.prismaService.$queryRawUnsafe(
              queryVectorSql,
              rankQueryExpression,
              titleQueryExpression
            )) as Array<{ query_vector: string | null }>

        queryVector = queryVectorRows[0]?.query_vector
      }

      if (!queryVector && !isShortAmbiguousQuery) {
        seedLookupAttempts += 1
        const relaxedQueryVectorRows = (isLongNaturalLanguageQuery && !hasDomainAnchor
          ? await this.prismaService.$queryRawUnsafe(queryVectorFastSql, seedQueryExpression)
          : await this.prismaService.$queryRawUnsafe(
              queryVectorSql,
              seedQueryExpression,
              titleQueryExpression
            )) as Array<{ query_vector: string | null }>

        queryVector = relaxedQueryVectorRows[0]?.query_vector
      }

      if (!queryVector && isShortAmbiguousQuery) {
        seedLookupAttempts += 1
        const fallbackVectorRows = (await this.prismaService.$queryRawUnsafe(
          fallbackVectorSql,
          queryPattern,
          queryPattern
        )) as Array<{ query_vector: string | null }>

        queryVector = fallbackVectorRows[0]?.query_vector
      }

      const seedLookupMs = Date.now() - seedLookupStartedAt

      if (!queryVector) {
        return {
          items: [],
          total: 0,
          learning: {
            generatedSql:
              `${seedTitleVectorSql.trim()}\n${queryVectorSql.trim()}\n${queryVectorFastSql.trim()}\n${fallbackVectorSql.trim()}\n-- no seed embedding found for query, ANN skipped\n-- embeddingModel: ${options.embeddingModel}, mode: ${effectiveMode}, bm25: ${options.bm25Enabled}, hybridRatio: ${options.hybridRatio}, ranking: ${rankingStrategy}, technicalSeedTsQuery: ${technicalSeedExpression || 'none'}`,
            executionPlan: {
              Plan: {
                'Node Type': 'Unavailable',
                Reason: 'No seed embedding found for ANN query'
              }
            },
            queryExplanation:
              'ANN mode requires at least one seed embedding from lexical full-text matching, but none was found.',
            keywordSignals,
            pipelineTimings: {
              normalizeAndAnalyzeMs,
              seedLookupMs,
              annQueryMs: 0,
              resultAssembleMs: 0,
              totalPipelineMs: Date.now() - pipelineStartedAt,
              seedLookupAttempts,
              seedFound: false
            }
          }
        }
      }

      const annQueryStartedAt = Date.now()
      const [rawRows, countRows, planRows] = await Promise.all([
        this.prismaService.$queryRawUnsafe(
          annSql,
          queryVector,
          candidatePool,
          options.bm25Enabled,
          rankQueryExpression,
          semanticWeight,
          keywordWeight,
          effectiveMode === 'ivf',
          options.limit,
          options.offset
        ),
        this.prismaService.$queryRawUnsafe(
          annCountSql,
          queryVector,
          candidatePool
        ),
        this.prismaService.$queryRawUnsafe(
          explainSql,
          queryVector,
          candidatePool,
          options.bm25Enabled,
          rankQueryExpression,
          semanticWeight,
          keywordWeight,
          effectiveMode === 'ivf',
          options.limit,
          options.offset
        )
      ])
      const annQueryMs = Date.now() - annQueryStartedAt
      const resultAssembleStartedAt = Date.now()

      const rows = rawRows as HybridSearchRow[]

      const total = Number(
        ((countRows as Array<{ total: bigint }>)[0]?.total ?? BigInt(0)).toString()
      )

      const executionPlan = this.parseExecutionPlan(
        planRows as Array<Record<string, unknown>>
      )

      const mappedItems = rows.map((row) => {
          const vectorScore = this.toUnitInterval(
            effectiveMode === 'ivf'
              ? Number(((-row.vector_distance + 1) / 2).toFixed(3))
              : Number((1 - row.vector_distance / 2).toFixed(3))
          )
          const bm25Score = this.toUnitInterval(
            Number(((row.bm25_score ?? 0) / (1 + (row.bm25_score ?? 0))).toFixed(3))
          )
          const score = this.toUnitInterval(
            Number((vectorScore * semanticWeight + bm25Score * keywordWeight).toFixed(3))
          )

          return {
            id: Number(row.id),
            title: row.title ?? 'Untitled Document',
              snippet: row.snippet,
              score,
              category: row.namespace ?? 'Unknown',
              distance: Number((1 - score).toFixed(4)),
              tags: this.toTags(row.contributors),
              matchRate: Number((score * 100).toFixed(1)),
              usedKeywords: weightedKeywords,
              matchedKeywords: this.findMatchedKeywords(
                weightedKeywords,
                `${row.title ?? ''} ${row.snippet}`
              )
            }
          })
      const resultAssembleMs = Date.now() - resultAssembleStartedAt

      return {
        items: mappedItems,
          total,
        learning: {
          generatedSql: `${seedTitleVectorSql.trim()}\n${queryVectorSql.trim()}\n${queryVectorFastSql.trim()}\n${fallbackVectorSql.trim()}\n${annSql.trim()}\n-- embeddingModel: ${options.embeddingModel}, mode: ${effectiveMode}, bm25: ${options.bm25Enabled}, hybridRatio: ${options.hybridRatio}, candidatePool: ${candidatePool}, tsConfig: ${tsConfig}, shortQueryStrategy: ${isShortAmbiguousQuery ? 'seed-priority' : 'standard'}, longQueryStrategy: ${isLongNaturalLanguageQuery ? 'term-selected-tsquery' : 'default'}, ranking: ${rankingStrategy}, domainAnchor: ${hasDomainAnchor ? 'on' : 'off'}, technicalSeedTsQuery: ${technicalSeedExpression || 'none'}, rankTsQuery: ${rankQueryExpression}`,
          executionPlan,
          queryExplanation: `${this.buildQueryExplanation(executionPlan)} Keywords used: ${weightedKeywords.join(', ') || 'none'}.`,
          keywordSignals,
          pipelineTimings: {
            normalizeAndAnalyzeMs,
            seedLookupMs,
            annQueryMs,
            resultAssembleMs,
            totalPipelineMs: Date.now() - pipelineStartedAt,
            seedLookupAttempts,
            seedFound: true
          }
        }
      }
    } catch (error) {
      return this.buildUnavailableResult(error)
    }
  }

  private buildUnavailableResult(error?: unknown): SearchExecutionResult {
    const reason =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : 'Database query failed'

    return {
      items: [],
      total: 0,
      learning: {
        generatedSql: '-- database unavailable: query execution skipped',
        executionPlan: {
          Plan: {
            'Node Type': 'Unavailable',
            Reason: reason
          }
        },
        queryExplanation:
          `Database query failed, so no search results were returned. Root cause: ${reason}. Check database connectivity and retry.`
      }
    }
  }

  private parseExecutionPlan(
    planRows: Array<Record<string, unknown>>
  ): Record<string, unknown> {
    const firstRow = planRows[0] ?? {}
    const rawPlan =
      firstRow['QUERY PLAN'] ?? firstRow.query_plan ?? firstRow['query_plan']

    if (Array.isArray(rawPlan) && rawPlan.length > 0) {
      const firstPlan = rawPlan[0] as Record<string, unknown>
      const nestedPlan = firstPlan.Plan

      if (typeof nestedPlan === 'object' && nestedPlan !== null) {
        return nestedPlan as Record<string, unknown>
      }

      return firstPlan
    }

    if (typeof rawPlan === 'object' && rawPlan !== null) {
      return rawPlan as Record<string, unknown>
    }

    return {
      Plan: {
        'Node Type': 'Unknown'
      }
    }
  }

  private buildQueryExplanation(plan: Record<string, unknown>): string {
    const nodeType =
      typeof plan['Node Type'] === 'string'
        ? (plan['Node Type'] as string)
        : 'Unknown Node'
    const relation =
      typeof plan['Relation Name'] === 'string'
        ? (plan['Relation Name'] as string)
        : 'unknown relation'
    const totalCost =
      typeof plan['Total Cost'] === 'number'
        ? (plan['Total Cost'] as number)
        : null
    const planRows =
      typeof plan['Plan Rows'] === 'number' ? (plan['Plan Rows'] as number) : null

    return `Planner selected ${nodeType} on ${relation}${
      totalCost !== null ? ` with total cost ${totalCost.toFixed(2)}` : ''
    }${planRows !== null ? ` and estimated rows ${planRows}` : ''}.`
  }

  private extractQueryTerms(normalizedQuery: string): string[] {
    return normalizedQuery
      .split(/\s+/)
      .map((term) => this.normalizeKeyword(term))
      .filter((term) => term.length > 0)
      .filter((term, index, source) => source.indexOf(term) === index)
  }

  private normalizeKeyword(rawTerm: string): string {
    const sanitizedTerm = rawTerm.replace(/[^\p{L}\p{N}]/gu, '').trim()

    if (!sanitizedTerm) {
      return ''
    }

    const strippedTerm = sanitizedTerm.replace(AppService.KOREAN_POSTPOSITION_SUFFIX_PATTERN, '')

    return strippedTerm || sanitizedTerm
  }

  private buildKeywordSignals(
    queryTerms: string[],
    isLongNaturalLanguageQuery: boolean
  ): SearchKeywordSignal[] {
    const baseSignals = queryTerms.map((keyword, index) => {
      const lengthWeight = Math.min(keyword.length / 8, 1)
      const positionWeight = Math.max(0, 1 - index * 0.08)
      const longQueryBoost = isLongNaturalLanguageQuery && keyword.length >= 3 ? 1.1 : 1
      const weight = Number((lengthWeight * 0.7 + positionWeight * 0.3).toFixed(3))
      const domainAnchorBoost = this.isDomainAnchorKeyword(keyword) ? 1.35 : 1
      const broadBiasPenalty = this.isBroadBiasKeyword(keyword) ? 0.3 : 1
      const genericIntentPenalty = this.isGenericIntentKeyword(keyword) ? 0.45 : 1

      return {
        keyword,
        weight: Number(
          (weight * longQueryBoost * domainAnchorBoost * broadBiasPenalty * genericIntentPenalty).toFixed(3)
        )
      }
    })

    return baseSignals
      .slice()
      .sort((left, right) => right.weight - left.weight)
      .slice(0, 8)
  }

  private buildTsQueryExpression(
    keywords: string[],
    maxTerms: number,
    operator: '&' | '|'
  ): string {
    const selectedKeywords = keywords.slice(0, maxTerms)
    const escapedKeywords = selectedKeywords
      .map((keyword) => keyword.replace(/['&|!():*<>]/g, '').trim())
      .filter((keyword) => keyword.length > 0)

    if (escapedKeywords.length === 0) {
      return ''
    }

    return escapedKeywords.join(` ${operator} `)
  }

  private findMatchedKeywords(keywords: string[], target: string): string[] {
    const normalizedTarget = target.toLowerCase()

    return keywords.filter((keyword) => normalizedTarget.includes(keyword))
  }

  private extractTechnicalTerms(queryTerms: string[]): string[] {
    return queryTerms.filter((queryTerm) => /[a-z0-9]/i.test(queryTerm) && queryTerm.length >= 2)
  }

  private hasDomainAnchor(queryTerms: string[]): boolean {
    return queryTerms.some((queryTerm) => this.isDomainAnchorKeyword(queryTerm))
  }

  private isDomainAnchorKeyword(keyword: string): boolean {
    return AppService.DOMAIN_ANCHOR_KEYWORDS.includes(
      keyword.toLowerCase() as (typeof AppService.DOMAIN_ANCHOR_KEYWORDS)[number]
    )
  }

  private isBroadBiasKeyword(keyword: string): boolean {
    return AppService.BROAD_BIAS_KEYWORD_ROOTS.some((root) => keyword.startsWith(root))
  }

  private isGenericIntentKeyword(keyword: string): boolean {
    return AppService.GENERIC_INTENT_KEYWORDS.includes(
      keyword as (typeof AppService.GENERIC_INTENT_KEYWORDS)[number]
    )
  }

  private toTags(contributors: string | null): string[] {
    if (!contributors) {
      return ['NamuWiki']
    }

    const tokens = contributors
      .split(',')
      .map((token) => token.trim())
      .filter((token) => token.length > 0)
      .slice(0, 3)

    return tokens.length > 0 ? tokens : ['NamuWiki']
  }

  private toUnitInterval(value: number): number {
    return Number(Math.min(1, Math.max(0, value)).toFixed(3))
  }

}
