import {
  Body,
  Controller,
  Get,
  Post
} from '@nestjs/common'
import {
  AppService,
  SearchHybridOptions,
  SearchQueryOptions
} from './app.service'

interface SearchRequest {
  query: string
  offset?: number
  limit?: number
}

interface SearchHybridRequest extends SearchRequest {
  mode?: 'none' | 'hnsw' | 'ivf'
  bm25Enabled?: boolean
  hybridRatio?: number
}

interface ApiMeta {
  total: number
  offset: number
  limit: number
  tookMs?: number
  requestId?: string
}

interface ApiResponse<T> {
  success: boolean
  data: T[]
  error?: string
  meta?: ApiMeta
}

interface HealthData {
  status: string
  service: string
  database: string
}

interface SearchResultData {
  items: Array<{
    id: number
    title: string
    snippet: string
    score: number
    category?: string
    distance?: number
    tags?: string[]
    matchRate?: number
  }>
  learning: {
    generatedSql: string
    executionPlan: Record<string, unknown>
    queryExplanation: string
  }
}

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get('api/health')
  async health(): Promise<ApiResponse<HealthData>> {
    const health = await this.appService.health()

    return {
      success: health.success,
      data: [health.data],
      error: health.success ? undefined : 'Database connectivity check failed'
    }
  }

  @Post('api/search')
  async search(@Body() body: unknown): Promise<ApiResponse<SearchResultData>> {
    const parsedRequest = this.parseSearchRequest(body)

    if (parsedRequest.error) {
      return {
        success: false,
        data: [],
        error: parsedRequest.error
      }
    }

    const request = parsedRequest.value
    const startedAt = Date.now()

    try {
      const options: SearchQueryOptions = {
        offset: request.offset,
        limit: request.limit
      }
      const results = await this.appService.search(request.query, options)

      return {
        success: true,
        data: [
          {
            items: results.items,
            learning: results.learning
          }
        ],
        meta: {
          total: results.total,
          offset: options.offset,
          limit: options.limit,
          tookMs: Date.now() - startedAt
        }
      }
    } catch {
      return {
        success: false,
        data: [],
        error: 'Failed to build search response',
        meta: {
          total: 0,
          offset: request.offset,
          limit: request.limit,
          tookMs: Date.now() - startedAt
        }
      }
    }
  }

  @Post('api/search/hybrid')
  async searchHybrid(
    @Body() body: unknown
  ): Promise<ApiResponse<SearchResultData>> {
    const parsedRequest = this.parseSearchHybridRequest(body)

    if (parsedRequest.error) {
      return {
        success: false,
        data: [],
        error: parsedRequest.error
      }
    }

    const request = parsedRequest.value
    const startedAt = Date.now()

    try {
      const options: SearchHybridOptions = {
        offset: request.offset,
        limit: request.limit,
        mode: request.mode,
        bm25Enabled: request.bm25Enabled,
        hybridRatio: request.hybridRatio
      }

      const results = await this.appService.searchHybrid(request.query, options)

      return {
        success: true,
        data: [
          {
            items: results.items,
            learning: results.learning
          }
        ],
        meta: {
          total: results.total,
          offset: options.offset,
          limit: options.limit,
          tookMs: Date.now() - startedAt
        }
      }
    } catch {
      return {
        success: false,
        data: [],
        error: 'Failed to build hybrid search response',
        meta: {
          total: 0,
          offset: request.offset,
          limit: request.limit,
          tookMs: Date.now() - startedAt
        }
      }
    }
  }

  private parseSearchRequest(
    body: unknown
  ): { value: Required<SearchRequest>; error?: string } {
    if (!this.hasQuery(body) || typeof body.query !== 'string') {
      return {
        value: {
          query: '',
          offset: 0,
          limit: 20
        },
        error: 'query must be provided as string'
      }
    }

    const normalizedQuery = body.query.trim()

    if (!normalizedQuery) {
      return {
        value: {
          query: '',
          offset: 0,
          limit: 20
        },
        error: 'query is required'
      }
    }

    if (normalizedQuery.length > 200) {
      return {
        value: {
          query: '',
          offset: 0,
          limit: 20
        },
        error: 'query length must be 200 or fewer'
      }
    }

    const offset = this.toIntOrDefault(this.pickOptionalNumber(body, 'offset'), 0)
    const limit = this.toIntOrDefault(this.pickOptionalNumber(body, 'limit'), 20)

    if (offset < 0) {
      return {
        value: {
          query: normalizedQuery,
          offset: 0,
          limit: 20
        },
        error: 'offset must be 0 or greater'
      }
    }

    if (limit < 1 || limit > 100) {
      return {
        value: {
          query: normalizedQuery,
          offset,
          limit: 20
        },
        error: 'limit must be between 1 and 100'
      }
    }

    return {
      value: {
        query: normalizedQuery,
        offset,
        limit
      }
    }
  }

  private parseSearchHybridRequest(
    body: unknown
  ): {
    value: Required<SearchHybridRequest>
    error?: string
  } {
    const parsedSearch = this.parseSearchRequest(body)

    if (parsedSearch.error) {
      return {
        value: {
          query: '',
          offset: 0,
          limit: 20,
          mode: 'none',
          bm25Enabled: true,
          hybridRatio: 50
        },
        error: parsedSearch.error
      }
    }

    const mode = this.pickOptionalString(body, 'mode') ?? 'none'
    const bm25Enabled =
      this.pickOptionalBoolean(body, 'bm25Enabled') ?? true
    const hybridRatio = this.toIntOrDefault(
      this.pickOptionalNumber(body, 'hybridRatio'),
      50
    )

    if (!['none', 'hnsw', 'ivf'].includes(mode)) {
      return {
        value: {
          ...parsedSearch.value,
          mode: 'none',
          bm25Enabled,
          hybridRatio
        },
        error: 'mode must be one of none, hnsw, ivf'
      }
    }

    if (hybridRatio < 0 || hybridRatio > 100) {
      return {
        value: {
          ...parsedSearch.value,
          mode: mode as 'none' | 'hnsw' | 'ivf',
          bm25Enabled,
          hybridRatio: 50
        },
        error: 'hybridRatio must be between 0 and 100'
      }
    }

    return {
      value: {
        ...parsedSearch.value,
        mode: mode as 'none' | 'hnsw' | 'ivf',
        bm25Enabled,
        hybridRatio
      }
    }
  }

  private pickOptionalNumber(
    value: unknown,
    key: string
  ): number | undefined {
    if (typeof value !== 'object' || value === null || !(key in value)) {
      return undefined
    }

    const raw = (value as Record<string, unknown>)[key]

    if (typeof raw === 'number') {
      return raw
    }

    if (typeof raw === 'string' && raw.trim()) {
      const parsed = Number(raw)
      return Number.isFinite(parsed) ? parsed : undefined
    }

    return undefined
  }

  private pickOptionalString(
    value: unknown,
    key: string
  ): string | undefined {
    if (typeof value !== 'object' || value === null || !(key in value)) {
      return undefined
    }

    const raw = (value as Record<string, unknown>)[key]
    return typeof raw === 'string' ? raw : undefined
  }

  private pickOptionalBoolean(
    value: unknown,
    key: string
  ): boolean | undefined {
    if (typeof value !== 'object' || value === null || !(key in value)) {
      return undefined
    }

    const raw = (value as Record<string, unknown>)[key]
    return typeof raw === 'boolean' ? raw : undefined
  }

  private toIntOrDefault(value: number | undefined, fallback: number): number {
    if (value === undefined) {
      return fallback
    }

    if (!Number.isFinite(value)) {
      return fallback
    }

    return Math.trunc(value)
  }

  private hasQuery(value: unknown): value is { query: unknown } {
    return typeof value === 'object' && value !== null && 'query' in value
  }
}
