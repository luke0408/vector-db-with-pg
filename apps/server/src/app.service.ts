import { Injectable } from '@nestjs/common'
import { PrismaService } from './prisma/prisma.service'

export interface SearchResult {
  id: number
  title: string
  snippet: string
  score: number
  category?: string
  distance?: number
  tags?: string[]
  matchRate?: number
}

export interface SearchLearningData {
  generatedSql: string
  executionPlan: Record<string, unknown>
  queryExplanation: string
}

export interface SearchResponseData {
  items: SearchResult[]
  learning: SearchLearningData
}

export interface SearchQueryOptions {
  offset: number
  limit: number
}

export interface SearchHybridOptions extends SearchQueryOptions {
  mode: 'none' | 'hnsw' | 'ivf'
  bm25Enabled: boolean
  hybridRatio: number
}

interface HybridSearchRow {
  id: bigint
  title: string | null
  snippet: string
  namespace: string | null
  contributors: string | null
  vector_distance: number
  bm25_score: number
}

interface SearchExecutionResult {
  items: SearchResult[]
  total: number
  learning: SearchLearningData
}

@Injectable()
export class AppService {
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
          queryExplanation: 'No query provided'
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
    } catch {
      return this.buildUnavailableResult()
    }
  }

  async searchHybrid(
    query: string,
    options: SearchHybridOptions
  ): Promise<SearchExecutionResult> {
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
    const semanticWeight = Number((options.hybridRatio / 100).toFixed(3))
    const keywordWeight = options.bm25Enabled
      ? Number((1 - semanticWeight).toFixed(3))
      : 0

    if (options.mode === 'none') {
      const hybridSql = `
      SELECT
        id,
        title,
        LEFT(content, 240) AS snippet,
        namespace,
        contributors,
        CASE
          WHEN LOWER(COALESCE(title, '')) LIKE $1 THEN 0.98
          WHEN LOWER(content) LIKE $2 THEN 0.86
          ELSE 0.72
        END AS vector_score,
        CASE
          WHEN $3::boolean = true THEN ts_rank_cd(COALESCE(search_vector, ''::tsvector), plainto_tsquery('simple', $4))
          ELSE 0
        END AS bm25_score
      FROM namuwiki_documents
      WHERE LOWER(COALESCE(title, '')) LIKE $5
         OR LOWER(content) LIKE $6
      ORDER BY (($7 * CASE
          WHEN LOWER(COALESCE(title, '')) LIKE $1 THEN 0.98
          WHEN LOWER(content) LIKE $2 THEN 0.86
          ELSE 0.72
        END) + ($8 * CASE
          WHEN $3::boolean = true THEN ts_rank_cd(COALESCE(search_vector, ''::tsvector), plainto_tsquery('simple', $4))
          ELSE 0
        END)) DESC,
        id DESC
      LIMIT $9 OFFSET $10
    `

      const countSql = `
      SELECT COUNT(*)::bigint AS total
      FROM namuwiki_documents
      WHERE LOWER(COALESCE(title, '')) LIKE $1
         OR LOWER(content) LIKE $2
    `

      const explainSql = `EXPLAIN (FORMAT JSON) ${hybridSql}`

      try {
        const [rawRows, countRows, planRows] = await Promise.all([
          this.prismaService.$queryRawUnsafe(
            hybridSql,
            queryPattern,
            queryPattern,
            options.bm25Enabled,
            normalizedQuery,
            queryPattern,
            queryPattern,
            semanticWeight,
            keywordWeight,
            options.limit,
            options.offset
          ),
          this.prismaService.$queryRawUnsafe(countSql, queryPattern, queryPattern),
          this.prismaService.$queryRawUnsafe(
            explainSql,
            queryPattern,
            queryPattern,
            options.bm25Enabled,
            normalizedQuery,
            queryPattern,
            queryPattern,
            semanticWeight,
            keywordWeight,
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
          vector_score: number
          bm25_score: number
        }>

        const total = Number(
          ((countRows as Array<{ total: bigint }>)[0]?.total ?? BigInt(0)).toString()
        )

        const executionPlan = this.parseExecutionPlan(
          planRows as Array<Record<string, unknown>>
        )

        return {
          items: rows.map((row) => {
            const score = Number(
              (row.vector_score * semanticWeight + row.bm25_score * keywordWeight).toFixed(3)
            )

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
            generatedSql: `${hybridSql.trim()}\n-- mode: ${options.mode}, bm25: ${options.bm25Enabled}, hybridRatio: ${options.hybridRatio}`,
            executionPlan,
            queryExplanation: this.buildQueryExplanation(executionPlan)
          }
        }
      } catch {
        return this.buildUnavailableResult()
      }
    }

    const queryVectorSql = `
      SELECT embedding::text AS query_vector
      FROM namuwiki_documents
      WHERE search_vector @@ plainto_tsquery('simple', $1)
        AND embedding IS NOT NULL
      ORDER BY ts_rank_cd(search_vector, plainto_tsquery('simple', $1)) DESC,
               id DESC
      LIMIT 1
    `

    const distanceOperator = options.mode === 'ivf' ? '<#>' : '<=>'
    const candidatePool = Math.max(options.limit + options.offset, 20) * 25

    const annSql = `
      WITH ann_candidates AS (
        SELECT
          id,
          embedding ${distanceOperator} $1::vector AS vector_distance
        FROM namuwiki_documents
        WHERE embedding IS NOT NULL
        ORDER BY embedding ${distanceOperator} $1::vector
        LIMIT $2
      ),
      rescored AS (
        SELECT
          d.id,
          d.title,
          LEFT(d.content, 240) AS snippet,
          d.namespace,
          d.contributors,
          ann_candidates.vector_distance,
          CASE
            WHEN $3::boolean = true THEN ts_rank_cd(COALESCE(d.search_vector, ''::tsvector), plainto_tsquery('simple', $4))
            ELSE 0
          END AS bm25_score
        FROM ann_candidates
        JOIN namuwiki_documents d ON d.id = ann_candidates.id
        WHERE LOWER(COALESCE(d.title, '')) LIKE $5
           OR LOWER(d.content) LIKE $6
      )
      SELECT
        id,
        title,
        snippet,
        namespace,
        contributors,
        vector_distance,
        bm25_score
      FROM rescored
      ORDER BY (($7 * (1 - vector_distance)) + ($8 * bm25_score)) DESC,
               id DESC
      LIMIT $9 OFFSET $10
    `

    const annCountSql = `
      WITH ann_candidates AS (
        SELECT id
        FROM namuwiki_documents
        WHERE embedding IS NOT NULL
        ORDER BY embedding ${distanceOperator} $1::vector
        LIMIT $2
      )
      SELECT COUNT(*)::bigint AS total
      FROM ann_candidates
      JOIN namuwiki_documents d ON d.id = ann_candidates.id
      WHERE LOWER(COALESCE(d.title, '')) LIKE $3
         OR LOWER(d.content) LIKE $4
    `

    const explainSql = `EXPLAIN (FORMAT JSON) ${annSql}`

    try {
      const queryVectorRows = (await this.prismaService.$queryRawUnsafe(
        queryVectorSql,
        normalizedQuery
      )) as Array<{ query_vector: string | null }>

      const queryVector = queryVectorRows[0]?.query_vector

      if (!queryVector) {
        return {
          items: [],
          total: 0,
          learning: {
            generatedSql:
              `${queryVectorSql.trim()}\n-- no seed embedding found for query, ANN skipped\n-- mode: ${options.mode}, bm25: ${options.bm25Enabled}, hybridRatio: ${options.hybridRatio}`,
            executionPlan: {
              Plan: {
                'Node Type': 'Unavailable',
                Reason: 'No seed embedding found for ANN query'
              }
            },
            queryExplanation:
              'ANN mode requires at least one seed embedding from lexical full-text matching, but none was found.'
          }
        }
      }

      const [rawRows, countRows, planRows] = await Promise.all([
        this.prismaService.$queryRawUnsafe(
          annSql,
          queryVector,
          candidatePool,
          options.bm25Enabled,
          normalizedQuery,
          queryPattern,
          queryPattern,
          semanticWeight,
          keywordWeight,
          options.limit,
          options.offset
        ),
        this.prismaService.$queryRawUnsafe(
          annCountSql,
          queryVector,
          candidatePool,
          queryPattern,
          queryPattern
        ),
        this.prismaService.$queryRawUnsafe(
          explainSql,
          queryVector,
          candidatePool,
          options.bm25Enabled,
          normalizedQuery,
          queryPattern,
          queryPattern,
          semanticWeight,
          keywordWeight,
          options.limit,
          options.offset
        )
      ])

      const rows = rawRows as HybridSearchRow[]

      const total = Number(
        ((countRows as Array<{ total: bigint }>)[0]?.total ?? BigInt(0)).toString()
      )

      const executionPlan = this.parseExecutionPlan(
        planRows as Array<Record<string, unknown>>
      )

      return {
        items: rows.map((row) => {
          const vectorScore = Number((1 - row.vector_distance).toFixed(3))
          const score = Number(
            (vectorScore * semanticWeight + row.bm25_score * keywordWeight).toFixed(3)
          )

          return {
            id: Number(row.id),
            title: row.title ?? 'Untitled Document',
            snippet: row.snippet,
            score,
            category: row.namespace ?? 'Unknown',
            distance: Number(row.vector_distance.toFixed(4)),
            tags: this.toTags(row.contributors),
            matchRate: Number((score * 100).toFixed(1))
          }
        }),
        total,
        learning: {
          generatedSql: `${queryVectorSql.trim()}\n${annSql.trim()}\n-- mode: ${options.mode}, bm25: ${options.bm25Enabled}, hybridRatio: ${options.hybridRatio}, candidatePool: ${candidatePool}`,
          executionPlan,
          queryExplanation: this.buildQueryExplanation(executionPlan)
        }
      }
    } catch {
      return this.buildUnavailableResult()
    }
  }

  private buildUnavailableResult(): SearchExecutionResult {
    return {
      items: [],
      total: 0,
      learning: {
        generatedSql: '-- database unavailable: query execution skipped',
        executionPlan: {
          Plan: {
            'Node Type': 'Unavailable',
            Reason: 'Database query failed'
          }
        },
        queryExplanation:
          'Database query failed, so no search results were returned. Check database connectivity and retry.'
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

}
