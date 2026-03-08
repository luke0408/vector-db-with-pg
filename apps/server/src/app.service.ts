import { Injectable } from '@nestjs/common'
import { PrismaService } from './prisma/prisma.service'
import { QueryEmbeddingService } from './query-embedding.service'
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

interface LexicalFallbackRow {
  id: bigint
  title: string | null
  snippet: string
  namespace: string | null
  contributors: string | null
  bm25_score?: number
  title_match: boolean
  like_title_match: boolean
  like_content_match: boolean
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
  private static readonly SHORT_QUERY_POOL_MULTIPLIER = 12
  private static readonly DEFAULT_QUERY_POOL_MULTIPLIER = 9
  private static readonly LONG_QUERY_POOL_MULTIPLIER = 6
  private static readonly CANDIDATE_POOL_MAX = 120
  private static readonly CANDIDATE_POOL_MIN_WINDOW = 10
  private static readonly BM25_LONG_QUERY_MAX_TERMS = 3
  private static readonly BM25_DEFAULT_MAX_TERMS = 4
  private static readonly ANN_FALLBACK_MIN_TOP_SCORE = 0.34

  constructor(
    private readonly prismaService: PrismaService,
    private readonly queryEmbeddingService: QueryEmbeddingService
  ) {}

  async health() {
    let database = 'up'
    let status = 'ok'

    try {
      await this.prismaService.$queryRawUnsafe('SELECT 1')
    } catch {
      database = 'down'
      status = 'degraded'
    }

    const queryEmbedding = this.queryEmbeddingService.getHealthStatus()

    return {
      success: database === 'up',
      data: {
        status,
        service: 'vector-search-server',
        database,
        prewarm: queryEmbedding
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
    const includeExplain = this.shouldIncludeExplain()

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
        includeExplain
          ? this.prismaService.$queryRawUnsafe(
              explainSql,
              queryPattern,
              queryPattern,
              queryPattern,
              queryPattern,
              options.limit,
              options.offset
            )
          : Promise.resolve([])
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

      const executionPlan = includeExplain
        ? this.parseExecutionPlan(planRows as Array<Record<string, unknown>>)
        : {}
      const queryExplanation = includeExplain
        ? this.buildQueryExplanation(executionPlan)
        : 'Execution plan omitted because SEARCH_INCLUDE_EXPLAIN is disabled.'

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
          queryExplanation
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
    const trimmedQuery = query.trim()
    const normalizedQuery = trimmedQuery.toLowerCase()

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

    const isLongNaturalLanguageQuery = queryTerms.length >= 4 || normalizedQuery.length >= 16
    const keywordSignals = this.buildKeywordSignals(queryTerms, isLongNaturalLanguageQuery)
    const weightedKeywords = keywordSignals.map((signal) => signal.keyword)
    const bm25QueryText = this.buildBm25QueryText(weightedKeywords, isLongNaturalLanguageQuery)
    const effectiveMode: 'hnsw' | 'ivf' = options.mode === 'ivf' ? 'ivf' : 'hnsw'
    const semanticWeight = options.bm25Enabled ? Number((options.hybridRatio / 100).toFixed(3)) : 1
    const keywordWeight = options.bm25Enabled ? Number((1 - semanticWeight).toFixed(3)) : 0
    const rankingStrategy = options.bm25Enabled ? 'vector+bm25-hybrid' : 'vector-distance-only'
    const normalizeAndAnalyzeMs = Date.now() - analyzeStartedAt

    const sourceJoin = options.embeddingModel === 'qwen3'
      ? 'namuwiki_document_embeddings_qwen qe JOIN namuwiki_documents d ON d.doc_hash = qe.doc_hash'
      : 'namuwiki_documents d'
    const embeddingExpr = options.embeddingModel === 'qwen3' ? 'qe.embedding' : 'd.embedding'
    const distanceOperator = effectiveMode === 'ivf' ? '<#>' : '<=>'
    const candidatePool = this.resolveCandidatePool(
      queryTerms,
      normalizedQuery,
      options.limit,
      options.offset
    )

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
              THEN ts_rank_cd(COALESCE(d.search_vector, ''::tsvector), plainto_tsquery('${tsConfig}', $4), 32)
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
    const includeExplain = this.shouldIncludeExplain()

    try {
      const vectorPreparationStartedAt = Date.now()
      const embeddingsAvailable = await this.hasEmbeddings(options.embeddingModel)
      const queryEmbeddingAttempt = embeddingsAvailable
        ? await this.queryEmbeddingService.embedQuery(trimmedQuery, options.embeddingModel)
        : {
            reason: `embedding-store-empty:${options.embeddingModel}`
          }
      const queryVector = queryEmbeddingAttempt.vectorLiteral ?? null
      const queryEmbeddingReason =
        queryVector !== null
          ? 'model-generated'
          : (queryEmbeddingAttempt.reason ?? 'query-embedding-unavailable')
      const seedLookupMs = Date.now() - vectorPreparationStartedAt
      const seedLookupAttempts = embeddingsAvailable ? 1 : 0

      if (!queryVector) {
        if (options.bm25Enabled) {
          return this.searchHybridLexicalFallback(
            query,
            normalizedQuery,
            queryPattern,
            bm25QueryText,
            weightedKeywords,
            keywordSignals,
            options,
            tsConfig,
            normalizeAndAnalyzeMs,
            seedLookupMs,
            seedLookupAttempts,
            pipelineStartedAt,
            queryEmbeddingReason
          )
        }

        const lexicalFallbackResult = await this.search(query, options)

        return {
          items: lexicalFallbackResult.items,
          total: lexicalFallbackResult.total,
          learning: {
            ...lexicalFallbackResult.learning,
            generatedSql:
              `${lexicalFallbackResult.learning.generatedSql}\n-- fallback: lexical-like, reason: ${queryEmbeddingReason}, embeddingModel: ${options.embeddingModel}`,
            queryExplanation:
              `${lexicalFallbackResult.learning.queryExplanation} Fell back to lexical LIKE search because ${queryEmbeddingReason}.`,
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
          bm25QueryText,
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
        includeExplain
          ? this.prismaService.$queryRawUnsafe(
              explainSql,
              queryVector,
              candidatePool,
              options.bm25Enabled,
              bm25QueryText,
              semanticWeight,
              keywordWeight,
              effectiveMode === 'ivf',
              options.limit,
              options.offset
            )
          : Promise.resolve([])
      ])
      const annQueryMs = Date.now() - annQueryStartedAt
      const resultAssembleStartedAt = Date.now()

      const rows = rawRows as HybridSearchRow[]

      const total = Number(
        ((countRows as Array<{ total: bigint }>)[0]?.total ?? BigInt(0)).toString()
      )

      const annPreviewItems = rows.map((row) =>
        this.mapHybridRowToSearchResult(
          row,
          weightedKeywords,
          effectiveMode,
          semanticWeight,
          keywordWeight
        )
      )

      const weakAnnSignal = this.shouldFallbackFromWeakAnn(
        annPreviewItems,
        options.limit,
        isLongNaturalLanguageQuery,
        options.bm25Enabled
      )

      if (((rows.length === 0 || total === 0) || weakAnnSignal) && options.bm25Enabled) {
        return this.searchHybridLexicalFallback(
          query,
          normalizedQuery,
          queryPattern,
          bm25QueryText,
          weightedKeywords,
          keywordSignals,
          options,
          tsConfig,
          normalizeAndAnalyzeMs,
          seedLookupMs,
          seedLookupAttempts,
          pipelineStartedAt,
          weakAnnSignal ? 'ann-signal-weak' : 'ann-candidates-empty'
        )
      }

      const executionPlan = includeExplain
        ? this.parseExecutionPlan(planRows as Array<Record<string, unknown>>)
        : {}
      const queryExplanation = includeExplain
        ? `${this.buildQueryExplanation(executionPlan)} Used model-generated query embedding. Keywords used: ${weightedKeywords.join(', ') || 'none'}.`
        : `Execution plan omitted because SEARCH_INCLUDE_EXPLAIN is disabled. Used model-generated query embedding. Keywords used: ${weightedKeywords.join(', ') || 'none'}.`
      const mappedItems = annPreviewItems
      const resultAssembleMs = Date.now() - resultAssembleStartedAt

      return {
        items: mappedItems,
        total,
        learning: {
          generatedSql:
            `${annSql.trim()}\n-- queryVectorSource: runtime-query-embedding, queryEmbedding: ${queryEmbeddingReason}, embeddingModel: ${options.embeddingModel}, requestedMode: ${options.mode}, effectiveMode: ${effectiveMode}, bm25: ${options.bm25Enabled}, hybridRatio: ${options.hybridRatio}, candidatePool: ${candidatePool}, tsConfig: ${tsConfig}, ranking: ${rankingStrategy}, rankTsQuery: ${weightedKeywords.join(' ') || 'none'}, bm25QueryText: ${bm25QueryText || 'none'}, bm25TsQueryMode: plainto_tsquery`,
          executionPlan,
          queryExplanation,
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
      if (options.bm25Enabled) {
        return this.searchHybridLexicalFallback(
          query,
          normalizedQuery,
          queryPattern,
          bm25QueryText,
          weightedKeywords,
          keywordSignals,
          options,
          tsConfig,
          normalizeAndAnalyzeMs,
          0,
          0,
          pipelineStartedAt,
          `ann-query-failed:${this.describeError(error)}`
        )
      }

      return this.buildUnavailableResult(error)
    }
  }

  private async searchHybridLexicalFallback(
    query: string,
    normalizedQuery: string,
    queryPattern: string,
    bm25QueryText: string,
    weightedKeywords: string[],
    keywordSignals: SearchKeywordSignal[],
    options: SearchHybridOptions,
    tsConfig: string,
    normalizeAndAnalyzeMs: number,
    seedLookupMs: number,
    seedLookupAttempts: number,
    pipelineStartedAt: number,
    fallbackReason: string
  ): Promise<SearchExecutionResult> {
    const fallbackSql = `
      WITH lexical_candidates AS (
        SELECT
          d.id,
          d.title,
          LEFT(d.content, 240) AS snippet,
          d.namespace,
          d.contributors,
          CASE
            WHEN COALESCE(d.search_vector, ''::tsvector) @@ plainto_tsquery('${tsConfig}', $1)
              THEN ts_rank_cd(COALESCE(d.search_vector, ''::tsvector), plainto_tsquery('${tsConfig}', $1), 32)
            ELSE 0
          END AS bm25_score,
          CASE
            WHEN to_tsvector('${tsConfig}', COALESCE(d.title, '')) @@ plainto_tsquery('${tsConfig}', $1)
              THEN true
            ELSE false
          END AS title_match,
          CASE
            WHEN LOWER(COALESCE(d.title, '')) LIKE $2 THEN true
            ELSE false
          END AS like_title_match,
          CASE
            WHEN LOWER(d.content) LIKE $3 THEN true
            ELSE false
          END AS like_content_match
        FROM namuwiki_documents d
        WHERE COALESCE(d.search_vector, ''::tsvector) @@ plainto_tsquery('${tsConfig}', $1)
           OR LOWER(COALESCE(d.title, '')) LIKE $2
           OR LOWER(d.content) LIKE $3
      )
      SELECT
        id,
        title,
        snippet,
        namespace,
        contributors,
        bm25_score,
        title_match,
        like_title_match,
        like_content_match
      FROM lexical_candidates
      ORDER BY
        title_match DESC,
        bm25_score DESC,
        like_title_match DESC,
        like_content_match DESC,
        id DESC
      LIMIT $4 OFFSET $5
    `

    const fallbackCountSql = `
      WITH lexical_candidates AS (
        SELECT d.id
        FROM namuwiki_documents d
        WHERE COALESCE(d.search_vector, ''::tsvector) @@ plainto_tsquery('${tsConfig}', $1)
           OR LOWER(COALESCE(d.title, '')) LIKE $2
           OR LOWER(d.content) LIKE $3
      )
      SELECT COUNT(*)::bigint AS total
      FROM lexical_candidates
    `

    const explainSql = `EXPLAIN (FORMAT JSON) ${fallbackSql}`
    const fallbackQueryStartedAt = Date.now()
    const includeExplain = this.shouldIncludeExplain()

    try {
      const [rawRows, countRows, planRows] = await Promise.all([
        this.prismaService.$queryRawUnsafe(
          fallbackSql,
          bm25QueryText,
          queryPattern,
          queryPattern,
          options.limit,
          options.offset
        ),
        this.prismaService.$queryRawUnsafe(
          fallbackCountSql,
          bm25QueryText,
          queryPattern,
          queryPattern
        ),
        includeExplain
          ? this.prismaService.$queryRawUnsafe(
              explainSql,
              bm25QueryText,
              queryPattern,
              queryPattern,
              options.limit,
              options.offset
            )
          : Promise.resolve([])
      ])
      const annQueryMs = Date.now() - fallbackQueryStartedAt
      const resultAssembleStartedAt = Date.now()
      const rows = rawRows as LexicalFallbackRow[]
      const total = Number(
        ((countRows as Array<{ total: bigint }>)[0]?.total ?? BigInt(0)).toString()
      )
      const executionPlan = includeExplain
        ? this.parseExecutionPlan(planRows as Array<Record<string, unknown>>)
        : {}
      const queryExplanation = includeExplain
        ? `${this.buildQueryExplanation(executionPlan)} Fell back to BM25 search because ${fallbackReason}. Keywords used: ${weightedKeywords.join(', ') || 'none'}.`
        : `Execution plan omitted because SEARCH_INCLUDE_EXPLAIN is disabled. Fell back to BM25 search because ${fallbackReason}. Keywords used: ${weightedKeywords.join(', ') || 'none'}.`

      const items = rows.map((row) => {
        const bm25Score = this.toUnitInterval(
          Number(((row.bm25_score ?? 0) / (1 + (row.bm25_score ?? 0))).toFixed(3))
        )
        const lexicalBoost = row.title_match
          ? 0.98
          : row.like_title_match
            ? 0.89
            : row.like_content_match
              ? 0.72
              : 0
        const score = this.toUnitInterval(
          Number(Math.max(bm25Score, lexicalBoost).toFixed(3))
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
        items,
        total,
        learning: {
          generatedSql:
            `${fallbackSql.trim()}\n-- fallbackStrategy: bm25-only, fallbackReason: ${fallbackReason}, embeddingModel: ${options.embeddingModel}, requestedMode: ${options.mode}, bm25: ${options.bm25Enabled}, hybridRatio: ${options.hybridRatio}, rankTsQuery: ${weightedKeywords.join(' ') || 'none'}, bm25QueryText: ${bm25QueryText || 'none'}`,
          executionPlan,
          queryExplanation,
          keywordSignals,
          pipelineTimings: {
            normalizeAndAnalyzeMs,
            seedLookupMs,
            annQueryMs,
            resultAssembleMs,
            totalPipelineMs: Date.now() - pipelineStartedAt,
            seedLookupAttempts,
            seedFound: false
          }
        }
      }
    } catch (error) {
      const unavailableResult = this.buildUnavailableResult(error)

      return {
        ...unavailableResult,
        learning: {
          ...unavailableResult.learning,
          generatedSql:
            `${unavailableResult.learning.generatedSql}\n-- fallbackStrategy: bm25-only, fallbackReason: ${fallbackReason}`,
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
  }

  private async hasEmbeddings(embeddingModel: EmbeddingModel): Promise<boolean> {
    const availabilitySql =
      embeddingModel === 'qwen3'
        ? `
          SELECT EXISTS(
            SELECT 1
            FROM namuwiki_document_embeddings_qwen
            WHERE embedding IS NOT NULL
          ) AS available
        `
        : `
          SELECT EXISTS(
            SELECT 1
            FROM namuwiki_documents
            WHERE embedding IS NOT NULL
          ) AS available
        `

    try {
      const rows = (await this.prismaService.$queryRawUnsafe(availabilitySql)) as Array<{
        available: boolean
      }>
      return Boolean(rows[0]?.available)
    } catch {
      return false
    }
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) {
      return error.message
    }

    return typeof error === 'string' ? error : 'unknown-error'
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

  private shouldIncludeExplain(): boolean {
    return process.env.SEARCH_INCLUDE_EXPLAIN !== 'false'
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
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
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

  private buildBm25QueryText(
    weightedKeywords: string[],
    isLongNaturalLanguageQuery: boolean
  ): string {
    const maxTerms = isLongNaturalLanguageQuery
      ? AppService.BM25_LONG_QUERY_MAX_TERMS
      : AppService.BM25_DEFAULT_MAX_TERMS

    return weightedKeywords.slice(0, maxTerms).join(' ').trim()
  }

  private resolveCandidatePool(
    queryTerms: string[],
    normalizedQuery: string,
    limit: number,
    offset: number
  ): number {
    const requestWindow = Math.max(
      limit + offset,
      limit,
      AppService.CANDIDATE_POOL_MIN_WINDOW
    )
    const isShortKeywordQuery = queryTerms.length <= 2 && normalizedQuery.length <= 12
    const isLongNaturalLanguageQuery = queryTerms.length >= 4 || normalizedQuery.length >= 16
    const poolMultiplier = isShortKeywordQuery
      ? AppService.SHORT_QUERY_POOL_MULTIPLIER
      : isLongNaturalLanguageQuery
        ? AppService.LONG_QUERY_POOL_MULTIPLIER
        : AppService.DEFAULT_QUERY_POOL_MULTIPLIER

    return Math.min(requestWindow * poolMultiplier, AppService.CANDIDATE_POOL_MAX)
  }

  private mapHybridRowToSearchResult(
    row: HybridSearchRow,
    weightedKeywords: string[],
    effectiveMode: 'hnsw' | 'ivf',
    semanticWeight: number,
    keywordWeight: number
  ): SearchResult {
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
  }

  private shouldFallbackFromWeakAnn(
    items: SearchResult[],
    limit: number,
    isLongNaturalLanguageQuery: boolean,
    bm25Enabled: boolean
  ): boolean {
    if (!bm25Enabled || !isLongNaturalLanguageQuery || items.length === 0) {
      return false
    }

    const topScore = items[0]?.score ?? 0
    const minimumExpectedItems = Math.min(limit, 3)

    return (
      topScore < AppService.ANN_FALLBACK_MIN_TOP_SCORE ||
      items.length < minimumExpectedItems
    )
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
