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

interface SearchExecutionResult {
  items: SearchResult[]
  total: number
  learning: SearchLearningData
}

@Injectable()
export class AppService {
  constructor(private readonly prismaService: PrismaService) {}

  private readonly dummySearchResults: ReadonlyArray<SearchResult> = [
    {
      id: 1,
      title: 'ARM (Architecture)',
      snippet:
        'ARM architecture is a family of reduced instruction set computer architectures for processors across mobile and server platforms.',
      score: 0.984
    },
    {
      id: 2,
      title: 'Bose Corporation',
      snippet:
        'Bose Corporation is an American manufacturing company known for home audio systems and active noise-cancelling headphones.',
      score: 0.891
    },
    {
      id: 3,
      title: 'SSD (Solid State Drive)',
      snippet:
        'A solid-state drive uses integrated circuits and flash memory to provide fast persistent storage in modern computing systems.',
      score: 0.847
    },
    {
      id: 4,
      title: 'AMOLED Display',
      snippet:
        'AMOLED is a display technology that combines organic light-emitting diodes with active-matrix pixel addressing.',
      score: 0.723
    }
  ]

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
      return this.buildFallbackResult(normalizedQuery, options)
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
      return this.buildFallbackResult(normalizedQuery, options)
    }
  }

  private buildFallbackResult(
    normalizedQuery: string,
    options: SearchQueryOptions
  ): SearchExecutionResult {
    const filtered = this.filterDummyResults(normalizedQuery)
    const paged = filtered.slice(options.offset, options.offset + options.limit)

    return {
      items: paged,
      total: filtered.length,
      learning: {
        generatedSql:
          '-- fallback mode: database query unavailable, returning in-memory dummy rows',
        executionPlan: {
          Plan: {
            'Node Type': 'FallbackInMemory',
            'Plan Rows': paged.length
          }
        },
        queryExplanation:
          'Database connection unavailable. Returned fallback in-memory sample results.'
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

  private filterDummyResults(normalizedQuery: string): SearchResult[] {
    const exactMatches = this.dummySearchResults.filter((result) =>
      result.title.toLowerCase().includes(normalizedQuery)
    )

    if (exactMatches.length > 0) {
      return exactMatches.map((result) => ({
        ...result,
        category: 'Fallback',
        distance: Number((1 - result.score).toFixed(4)),
        tags: ['Fallback'],
        matchRate: Number((result.score * 100).toFixed(1))
      }))
    }

    const snippetMatches = this.dummySearchResults.filter((result) =>
      result.snippet.toLowerCase().includes(normalizedQuery)
    )

    if (snippetMatches.length > 0) {
      return snippetMatches.map((result) => ({
        ...result,
        category: 'Fallback',
        distance: Number((1 - result.score).toFixed(4)),
        tags: ['Fallback'],
        matchRate: Number((result.score * 100).toFixed(1))
      }))
    }

    return this.dummySearchResults.map((result) => ({
      ...result,
      category: 'Fallback',
      distance: Number((1 - result.score).toFixed(4)),
      tags: ['Fallback'],
      matchRate: Number((result.score * 100).toFixed(1))
    }))
  }
}
