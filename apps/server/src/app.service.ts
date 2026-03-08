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
  tableName?: string
  embeddingModel?: EmbeddingModel
}

export interface SearchHybridOptions extends SearchQueryOptions {
  mode: 'none' | 'hnsw' | 'ivf'
  bm25Enabled: boolean
  hybridRatio: number
  embeddingModel: EmbeddingModel
}

interface ManagedSearchContext {
  tableName: string
  language: string
  tableSuffix: string
  idColumn: string
  docHashColumn: string | null
  titleColumn: string
  contentColumn: string
  textlenColumn: string
  ftsColumn: string
  embeddingColumn: string
  embeddingHnswColumn: string
  k1: number
  b: number
  supportsLegacyNamespace: boolean
  supportsLegacyContributors: boolean
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
    const tableContext = await this.resolveManagedSearchContext(options.tableName)

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
    const tableSql = this.quoteIdentifier(tableContext.tableName)
    const idColumnSql = this.columnRef('d', tableContext.idColumn)
    const titleColumnSql = this.columnRef('d', tableContext.titleColumn)
    const contentColumnSql = this.columnRef('d', tableContext.contentColumn)
    const snippetExpr = `LEFT(${contentColumnSql}, 240)`
    const namespaceExpr = tableContext.supportsLegacyNamespace
      ? 'd.namespace'
      : `${this.sqlStringLiteral(tableContext.tableName)}`
    const contributorsExpr = tableContext.supportsLegacyContributors
      ? 'd.contributors'
      : `NULL::text`
    const ftsExpr = this.buildSearchVectorExpression(tableContext, 'd')
    const languageLiteral = this.sqlStringLiteral(tableContext.language)

    const searchSql = `
      SELECT
        ${idColumnSql} AS id,
        ${titleColumnSql} AS title,
        ${snippetExpr} AS snippet,
        ${namespaceExpr} AS namespace,
        ${contributorsExpr} AS contributors,
        CASE
          WHEN LOWER(COALESCE(${titleColumnSql}, '')) LIKE $1 THEN 0.984
          WHEN ${ftsExpr} @@ plainto_tsquery(${languageLiteral}, $2) THEN 0.891
          WHEN LOWER(${contentColumnSql}) LIKE $3 THEN 0.723
          ELSE 0.723
        END AS score
      FROM ${tableSql} d
      WHERE LOWER(COALESCE(${titleColumnSql}, '')) LIKE $3
         OR ${ftsExpr} @@ plainto_tsquery(${languageLiteral}, $2)
         OR LOWER(${contentColumnSql}) LIKE $4
      ORDER BY score DESC, id DESC
      LIMIT $5 OFFSET $6
    `

    const countSql = `
      SELECT COUNT(*)::bigint AS total
      FROM ${tableSql} d
      WHERE LOWER(COALESCE(${titleColumnSql}, '')) LIKE $1
         OR ${ftsExpr} @@ plainto_tsquery(${languageLiteral}, $3)
         OR LOWER(${contentColumnSql}) LIKE $2
    `

    const explainSql = `EXPLAIN (FORMAT JSON) ${searchSql}`
    const includeExplain = this.shouldIncludeExplain()

    try {
      const [rawRows, countRows, planRows] = await Promise.all([
        this.prismaService.$queryRawUnsafe(
          searchSql,
          queryPattern,
          normalizedQuery,
          queryPattern,
          queryPattern,
          options.limit,
          options.offset
        ),
        this.prismaService.$queryRawUnsafe(countSql, queryPattern, queryPattern, normalizedQuery),
        includeExplain
          ? this.prismaService.$queryRawUnsafe(
              explainSql,
              queryPattern,
              normalizedQuery,
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
            category: row.namespace ?? tableContext.tableName,
            distance: Number((1 - score).toFixed(4)),
            tags: this.toTags(row.contributors),
            matchRate: Number((score * 100).toFixed(1))
          }
        }),
        total,
        learning: {
          generatedSql: `${searchSql.trim()}
-- managedTable: ${tableContext.tableName}, language: ${tableContext.language}`,
          executionPlan,
          queryExplanation: `${queryExplanation} Managed table: ${tableContext.tableName}. Language: ${tableContext.language}.`
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
    const tableContext = await this.resolveManagedSearchContext(options.tableName)
    const tsConfig = tableContext.language
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
    const bm25Tokens = await this.tokenizeForSearch(
      tsConfig,
      bm25QueryText || normalizedQuery,
      weightedKeywords
    )
    const effectiveMode: 'hnsw' | 'ivf' = options.mode === 'ivf' ? 'ivf' : 'hnsw'
    const semanticWeight = options.bm25Enabled ? Number((options.hybridRatio / 100).toFixed(3)) : 1
    const keywordWeight = options.bm25Enabled ? Number((1 - semanticWeight).toFixed(3)) : 0
    const rankingStrategy = options.bm25Enabled ? 'vector+bm25-hybrid' : 'vector-distance-only'
    const normalizeAndAnalyzeMs = Date.now() - analyzeStartedAt
    const sourceJoin = this.buildHybridSourceJoin(tableContext)
    const embeddingExpr = this.buildEmbeddingExpression(tableContext)
    const tableSql = this.quoteIdentifier(tableContext.tableName)
    const idColumnSql = this.columnRef('d', tableContext.idColumn)
    const titleColumnSql = this.columnRef('d', tableContext.titleColumn)
    const contentColumnSql = this.columnRef('d', tableContext.contentColumn)
    const textlenColumnSql = this.columnRef('d', tableContext.textlenColumn)
    const snippetExpr = `LEFT(${contentColumnSql}, 240)`
    const namespaceExpr = tableContext.supportsLegacyNamespace
      ? 'd.namespace'
      : `${this.sqlStringLiteral(tableContext.tableName)}`
    const contributorsExpr = tableContext.supportsLegacyContributors
      ? 'd.contributors'
      : 'NULL::text'
    const bm25ScoreExpr = this.buildBm25ScoreExpression(
      tableContext,
      idColumnSql,
      textlenColumnSql,
      4
    )
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
          ${idColumnSql} AS id,
          ${embeddingExpr} ${distanceOperator} $1::vector AS vector_distance
        FROM ${sourceJoin}
        WHERE ${embeddingExpr} IS NOT NULL
        ORDER BY ${embeddingExpr} ${distanceOperator} $1::vector
        LIMIT $2
      ),
      ranked_candidates AS (
        SELECT
          ${idColumnSql} AS id,
          ${titleColumnSql} AS title,
          ${snippetExpr} AS snippet,
          ${namespaceExpr} AS namespace,
          ${contributorsExpr} AS contributors,
          ann_candidates.vector_distance,
          CASE
            WHEN $3::boolean = true THEN ${bm25ScoreExpr}
            ELSE 0
          END AS bm25_score
        FROM ann_candidates
        JOIN ${tableSql} d ON ${idColumnSql} = ann_candidates.id
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
        SELECT ${idColumnSql} AS id
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
      const embeddingsAvailable = await this.hasEmbeddingsForContext(tableContext)
      const queryEmbeddingAttempt = embeddingsAvailable
        ? await this.queryEmbeddingService.embedQuery(trimmedQuery, options.embeddingModel)
        : {
            reason: `embedding-store-empty:${tableContext.tableName}`
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
            tableContext,
            normalizeAndAnalyzeMs,
            seedLookupMs,
            seedLookupAttempts,
            pipelineStartedAt,
            queryEmbeddingReason,
            bm25Tokens
          )
        }

        const lexicalFallbackResult = await this.search(query, options)

        return {
          items: lexicalFallbackResult.items,
          total: lexicalFallbackResult.total,
          learning: {
            ...lexicalFallbackResult.learning,
            generatedSql:
              `${lexicalFallbackResult.learning.generatedSql}
-- fallback: lexical-like, reason: ${queryEmbeddingReason}, embeddingModel: ${options.embeddingModel}, tableName: ${tableContext.tableName}`,
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
          bm25Tokens,
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
              bm25Tokens,
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
          keywordWeight,
          tableContext.tableName
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
          tableContext,
          normalizeAndAnalyzeMs,
          seedLookupMs,
          seedLookupAttempts,
          pipelineStartedAt,
          weakAnnSignal ? 'ann-signal-weak' : 'ann-candidates-empty',
          bm25Tokens
        )
      }

      const executionPlan = includeExplain
        ? this.parseExecutionPlan(planRows as Array<Record<string, unknown>>)
        : {}
      const queryExplanation = includeExplain
        ? `${this.buildQueryExplanation(executionPlan)} Used model-generated query embedding. Managed table: ${tableContext.tableName}. Language: ${tableContext.language}. Keywords used: ${weightedKeywords.join(', ') || 'none'}.`
        : `Execution plan omitted because SEARCH_INCLUDE_EXPLAIN is disabled. Used model-generated query embedding. Managed table: ${tableContext.tableName}. Language: ${tableContext.language}. Keywords used: ${weightedKeywords.join(', ') || 'none'}.`
      const mappedItems = annPreviewItems
      const resultAssembleMs = Date.now() - resultAssembleStartedAt

      return {
        items: mappedItems,
        total,
        learning: {
          generatedSql:
            `${annSql.trim()}
-- queryVectorSource: runtime-query-embedding, queryEmbedding: ${queryEmbeddingReason}, embeddingModel: ${options.embeddingModel}, requestedMode: ${options.mode}, effectiveMode: ${effectiveMode}, bm25: ${options.bm25Enabled}, hybridRatio: ${options.hybridRatio}, candidatePool: ${candidatePool}, tsConfig: ${tsConfig}, ranking: ${rankingStrategy}, rankTsQuery: ${weightedKeywords.join(' ') || 'none'}, bm25QueryText: ${bm25QueryText || 'none'}, bm25Tokens: ${bm25Tokens.join(' ') || 'none'}, managedTable: ${tableContext.tableName}`,
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
          tableContext,
          normalizeAndAnalyzeMs,
          0,
          0,
          pipelineStartedAt,
          `ann-query-failed:${this.describeError(error)}`,
          bm25Tokens
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
    tableContext: ManagedSearchContext,
    normalizeAndAnalyzeMs: number,
    seedLookupMs: number,
    seedLookupAttempts: number,
    pipelineStartedAt: number,
    fallbackReason: string,
    bm25Tokens: string[]
  ): Promise<SearchExecutionResult> {
    const languageLiteral = this.sqlStringLiteral(tableContext.language)
    const tableSql = this.quoteIdentifier(tableContext.tableName)
    const idColumnSql = this.columnRef('d', tableContext.idColumn)
    const titleColumnSql = this.columnRef('d', tableContext.titleColumn)
    const contentColumnSql = this.columnRef('d', tableContext.contentColumn)
    const textlenColumnSql = this.columnRef('d', tableContext.textlenColumn)
    const snippetExpr = `LEFT(${contentColumnSql}, 240)`
    const namespaceExpr = tableContext.supportsLegacyNamespace
      ? 'd.namespace'
      : `${this.sqlStringLiteral(tableContext.tableName)}`
    const contributorsExpr = tableContext.supportsLegacyContributors
      ? 'd.contributors'
      : 'NULL::text'
    const ftsExpr = this.buildSearchVectorExpression(tableContext, 'd')
    const bm25ScoreExpr = this.buildBm25ScoreExpression(
      tableContext,
      idColumnSql,
      textlenColumnSql,
      1
    )
    const fallbackSql = `
      WITH lexical_candidates AS (
        SELECT
          ${idColumnSql} AS id,
          ${titleColumnSql} AS title,
          ${snippetExpr} AS snippet,
          ${namespaceExpr} AS namespace,
          ${contributorsExpr} AS contributors,
          ${bm25ScoreExpr} AS bm25_score,
          CASE
            WHEN to_tsvector(${languageLiteral}, COALESCE(${titleColumnSql}, '')) @@ plainto_tsquery(${languageLiteral}, $2)
              THEN true
            ELSE false
          END AS title_match,
          CASE
            WHEN LOWER(COALESCE(${titleColumnSql}, '')) LIKE $3 THEN true
            ELSE false
          END AS like_title_match,
          CASE
            WHEN LOWER(${contentColumnSql}) LIKE $4 THEN true
            ELSE false
          END AS like_content_match
        FROM ${tableSql} d
        WHERE ${ftsExpr} @@ plainto_tsquery(${languageLiteral}, $2)
           OR LOWER(COALESCE(${titleColumnSql}, '')) LIKE $3
           OR LOWER(${contentColumnSql}) LIKE $4
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
      LIMIT $5 OFFSET $6
    `

    const fallbackCountSql = `
      WITH lexical_candidates AS (
        SELECT ${idColumnSql} AS id
        FROM ${tableSql} d
        WHERE ${ftsExpr} @@ plainto_tsquery(${languageLiteral}, $2)
           OR LOWER(COALESCE(${titleColumnSql}, '')) LIKE $3
           OR LOWER(${contentColumnSql}) LIKE $4
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
          bm25Tokens,
          bm25QueryText || normalizedQuery,
          queryPattern,
          queryPattern,
          options.limit,
          options.offset
        ),
        this.prismaService.$queryRawUnsafe(
          fallbackCountSql,
          bm25Tokens,
          bm25QueryText || normalizedQuery,
          queryPattern,
          queryPattern
        ),
        includeExplain
          ? this.prismaService.$queryRawUnsafe(
              explainSql,
              bm25Tokens,
              bm25QueryText || normalizedQuery,
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
        ? `${this.buildQueryExplanation(executionPlan)} Fell back to BM25 search because ${fallbackReason}. Managed table: ${tableContext.tableName}. Language: ${tableContext.language}. Keywords used: ${weightedKeywords.join(', ') || 'none'}.`
        : `Execution plan omitted because SEARCH_INCLUDE_EXPLAIN is disabled. Fell back to BM25 search because ${fallbackReason}. Managed table: ${tableContext.tableName}. Language: ${tableContext.language}. Keywords used: ${weightedKeywords.join(', ') || 'none'}.`

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
          category: row.namespace ?? tableContext.tableName,
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
            `${fallbackSql.trim()}
-- fallbackStrategy: bm25-only, fallbackReason: ${fallbackReason}, embeddingModel: ${options.embeddingModel}, requestedMode: ${options.mode}, bm25: ${options.bm25Enabled}, hybridRatio: ${options.hybridRatio}, rankTsQuery: ${weightedKeywords.join(' ') || 'none'}, bm25QueryText: ${bm25QueryText || 'none'}, bm25Tokens: ${bm25Tokens.join(' ') || 'none'}, managedTable: ${tableContext.tableName}`,
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
            `${unavailableResult.learning.generatedSql}
-- fallbackStrategy: bm25-only, fallbackReason: ${fallbackReason}, managedTable: ${tableContext.tableName}`,
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

  private async hasEmbeddingsForContext(
    tableContext: ManagedSearchContext
  ): Promise<boolean> {
    const availabilitySql = `
      SELECT EXISTS(
        SELECT 1
        FROM ${this.buildHybridSourceJoin(tableContext)}
        WHERE ${this.buildEmbeddingExpression(tableContext)} IS NOT NULL
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

  private async resolveManagedSearchContext(
    tableName?: string
  ): Promise<ManagedSearchContext> {
    const normalizedTableName = tableName?.trim()

    if (!normalizedTableName || normalizedTableName === 'namuwiki_documents') {
      return {
        tableName: 'namuwiki_documents',
        language: 'korean',
        tableSuffix: 'korean',
        idColumn: 'id',
        docHashColumn: 'doc_hash',
        titleColumn: 'title',
        contentColumn: 'content',
        textlenColumn: 'textlen',
        ftsColumn: 'fts',
        embeddingColumn: 'embedding_qwen',
        embeddingHnswColumn: 'embedding_hnsw',
        k1: 1.2,
        b: 0.75,
        supportsLegacyNamespace: true,
        supportsLegacyContributors: true
      }
    }

    const rows = await this.prismaService.$queryRawUnsafe(
      `
        SELECT
          mt.table_name,
          mt.language,
          mt.id_column,
          mt.doc_hash_column,
          mt.title_column,
          mt.content_column,
          mt.textlen_column,
          mt.fts_column,
          mt.embedding_column,
          mt.embedding_hnsw_column,
          COALESCE(sl.table_suffix, mt.language) AS table_suffix,
          COALESCE(settings.k1, 1.2) AS k1,
          COALESCE(settings.b, 0.75) AS b
        FROM search_managed_tables mt
        LEFT JOIN search_supported_languages sl
          ON sl.language = mt.language
        LEFT JOIN search_bm25_language_settings settings
          ON settings.language = mt.language
        WHERE mt.table_name = $1
          AND mt.is_active = TRUE
        LIMIT 1
      `,
      normalizedTableName
    ) as Array<{
      table_name: string
      language: string
      id_column: string
      doc_hash_column: string | null
      title_column: string
      content_column: string
      textlen_column: string
      fts_column: string
      embedding_column: string
      embedding_hnsw_column: string
      table_suffix: string
      k1: number
      b: number
    }>

    const row = rows[0]

    if (!row) {
      throw new Error(`Managed table not found: ${normalizedTableName}`)
    }

    return {
      tableName: row.table_name,
      language: row.language,
      tableSuffix: row.table_suffix,
      idColumn: row.id_column,
      docHashColumn: row.doc_hash_column,
      titleColumn: row.title_column,
      contentColumn: row.content_column,
      textlenColumn: row.textlen_column,
      ftsColumn: row.fts_column,
      embeddingColumn: row.embedding_column,
      embeddingHnswColumn: row.embedding_hnsw_column,
      k1: Number(row.k1),
      b: Number(row.b),
      supportsLegacyNamespace: false,
      supportsLegacyContributors: false
    }
  }

  private async tokenizeForSearch(
    language: string,
    query: string,
    fallbackTokens: string[]
  ): Promise<string[]> {
    const normalizedTokens = fallbackTokens
      .map((token) => token.trim())
      .filter((token) => token.length > 0)
      .filter((token, index, source) => source.indexOf(token) === index)

    if (normalizedTokens.length > 0) {
      return normalizedTokens
    }

    return this.extractQueryTerms(query.toLowerCase())
  }

  private buildHybridSourceJoin(tableContext: ManagedSearchContext): string {
    const tableSql = this.quoteIdentifier(tableContext.tableName)

    if (
      tableContext.tableName === 'namuwiki_documents' &&
      tableContext.docHashColumn === 'doc_hash'
    ) {
      return `${tableSql} d LEFT JOIN namuwiki_document_embeddings_qwen legacy ON legacy.doc_hash = d.${this.quoteIdentifier(tableContext.docHashColumn)}`
    }

    return `${tableSql} d`
  }

  private buildEmbeddingExpression(tableContext: ManagedSearchContext): string {
    const managedEmbeddingExpr = this.columnRef('d', tableContext.embeddingHnswColumn)

    if (
      tableContext.tableName === 'namuwiki_documents' &&
      tableContext.docHashColumn === 'doc_hash'
    ) {
      return `COALESCE(${managedEmbeddingExpr}, legacy.embedding)`
    }

    return managedEmbeddingExpr
  }

  private buildSearchVectorExpression(
    tableContext: ManagedSearchContext,
    alias: string
  ): string {
    const ftsColumnSql = this.columnRef(alias, tableContext.ftsColumn)
    const titleColumnSql = this.columnRef(alias, tableContext.titleColumn)
    const contentColumnSql = this.columnRef(alias, tableContext.contentColumn)
    const generatedVector = `to_tsvector(${this.sqlStringLiteral(tableContext.language)}, concat_ws(' ', COALESCE(${titleColumnSql}, ''), COALESCE(${contentColumnSql}, '')))`

    if (tableContext.tableName === 'namuwiki_documents') {
      return `COALESCE(${ftsColumnSql}, ${alias}.search_vector, ${generatedVector})`
    }

    return `COALESCE(${ftsColumnSql}, ${generatedVector})`
  }

  private buildBm25ScoreExpression(
    tableContext: ManagedSearchContext,
    docIdExpression: string,
    docLengthExpression: string,
    tokenParamIndex: number
  ): string {
    const tokenTable = this.quoteIdentifier(`bm25tokens_${tableContext.tableSuffix}`)
    const idfTable = this.quoteIdentifier(`bm25idf_${tableContext.tableSuffix}`)
    const lengthTable = this.quoteIdentifier(`bm25length_${tableContext.tableSuffix}`)
    const tableNameLiteral = this.sqlStringLiteral(tableContext.tableName)
    const k1 = Number(tableContext.k1.toFixed(6))
    const b = Number(tableContext.b.toFixed(6))
    const numeratorFactor = Number((k1 + 1).toFixed(6))

    return `COALESCE((
      WITH stats AS (
        SELECT
          COALESCE(SUM(recordcount), 0)::double precision AS doc_count,
          COALESCE(MAX(CASE WHEN tablename = ${tableNameLiteral} THEN avglen END), 0)::double precision AS avglen
        FROM ${lengthTable}
      )
      SELECT SUM(
        LN(1 + ((stats.doc_count - idf.tfdoc + 0.5) / (idf.tfdoc + 0.5))) *
        (
          (tok.tf * ${numeratorFactor}) /
          (
            tok.tf +
            ${k1} * (
              1 - ${b} +
              ${b} * COALESCE(${docLengthExpression}, 0)::double precision /
                NULLIF(stats.avglen, 0)
            )
          )
        )
      )
      FROM ${tokenTable} tok
      JOIN ${idfTable} idf
        ON idf.token = tok.token
      CROSS JOIN stats
      WHERE tok.id = ${docIdExpression}
        AND tok.token = ANY($${tokenParamIndex}::text[])
    ), 0)`
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
    keywordWeight: number,
    fallbackCategory: string
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
      category: row.namespace ?? fallbackCategory,
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

  private quoteIdentifier(identifier: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
      throw new Error(`Invalid SQL identifier: ${identifier}`)
    }

    return `"${identifier}"`
  }

  private columnRef(alias: string, column: string): string {
    return `${alias}.${this.quoteIdentifier(column)}`
  }

  private sqlStringLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`
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
