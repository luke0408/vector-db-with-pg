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
import {
  ApiResponse,
  SearchHybridRequest,
  SearchMode,
  SearchRequest
} from './types/search-contract'

interface HealthData {
  status: string
  service: string
  database: string
}

interface ParsedSearchRequest {
  query: string
  offset: number
  limit: number
}

interface ParsedSearchHybridRequest extends ParsedSearchRequest {
  mode: SearchMode
  bm25Enabled: boolean
  hybridRatio: number
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
    usedKeywords?: string[]
    matchedKeywords?: string[]
  }>
  learning: {
    generatedSql: string
    executionPlan: Record<string, unknown>
    queryExplanation: string
    keywordSignals?: Array<{
      keyword: string
      weight: number
    }>
    pipelineTimings?: {
      normalizeAndAnalyzeMs: number
      seedLookupMs: number
      annQueryMs: number
      resultAssembleMs: number
      totalPipelineMs: number
      seedLookupAttempts: number
      seedFound: boolean
    }
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
      const tookMs = Date.now() - startedAt

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
          tookMs
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
      const tookMs = Date.now() - startedAt

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
          tookMs
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
  ): { value: ParsedSearchRequest; error?: string } {
    const rawRequest = this.toSearchRequestCandidate(body)

    if (!rawRequest || typeof rawRequest.query !== 'string') {
      return {
        value: {
          query: '',
          offset: 0,
          limit: 20
        },
        error: 'query must be provided as string'
      }
    }

    const normalizedQuery = rawRequest.query.trim()

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

    const offset = this.toIntOrDefault(rawRequest.offset, 0)
    const limit = this.toIntOrDefault(rawRequest.limit, 20)

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
    value: ParsedSearchHybridRequest
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

    const rawRequest = this.toSearchHybridRequestCandidate(body)
    const mode = rawRequest?.mode ?? 'none'
    const bm25Enabled = rawRequest?.bm25Enabled ?? true
    const hybridRatio = this.toIntOrDefault(
      rawRequest?.hybridRatio,
      50
    )

    if (!this.isSearchMode(mode)) {
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
          mode,
          bm25Enabled,
          hybridRatio: 50
        },
        error: 'hybridRatio must be between 0 and 100'
      }
    }

    return {
      value: {
        ...parsedSearch.value,
        mode,
        bm25Enabled,
        hybridRatio
      }
    }
  }

  private toSearchRequestCandidate(value: unknown): Partial<SearchRequest> | null {
    if (typeof value !== 'object' || value === null) {
      return null
    }

    const raw = value as Record<string, unknown>

    return {
      query: typeof raw.query === 'string' ? raw.query : undefined,
      offset: this.pickOptionalNumber(raw, 'offset'),
      limit: this.pickOptionalNumber(raw, 'limit')
    }
  }

  private toSearchHybridRequestCandidate(
    value: unknown
  ): Partial<SearchHybridRequest> | null {
    if (typeof value !== 'object' || value === null) {
      return null
    }

    const raw = value as Record<string, unknown>

    return {
      ...this.toSearchRequestCandidate(value),
      mode: this.pickOptionalString(raw, 'mode') as SearchMode | undefined,
      bm25Enabled: this.pickOptionalBoolean(raw, 'bm25Enabled'),
      hybridRatio: this.pickOptionalNumber(raw, 'hybridRatio')
    }
  }

  private isSearchMode(mode: string): mode is SearchMode {
    return mode === 'none' || mode === 'hnsw' || mode === 'ivf'
  }

  private pickOptionalNumber(
    value: Record<string, unknown>,
    key: string
  ): number | undefined {
    if (!(key in value)) {
      return undefined
    }

    const raw = value[key]

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
    value: Record<string, unknown>,
    key: string
  ): string | undefined {
    if (!(key in value)) {
      return undefined
    }

    const raw = value[key]
    return typeof raw === 'string' ? raw : undefined
  }

  private pickOptionalBoolean(
    value: Record<string, unknown>,
    key: string
  ): boolean | undefined {
    if (!(key in value)) {
      return undefined
    }

    const raw = value[key]
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
}
