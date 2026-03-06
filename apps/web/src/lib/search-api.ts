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

export interface SearchResponseData {
  items: SearchResult[]
  learning: SearchLearningData
}

export interface SearchMeta {
  total: number
  offset: number
  limit: number
  tookMs?: number
  requestId?: string
  embeddingModelUsed?: 'base' | 'qwen3'
}

export interface SearchResponse {
  success: boolean
  data: SearchResponseData[]
  error?: string
  meta?: SearchMeta
}

export interface SearchRequestOptions {
  offset?: number
  limit?: number
  useHybrid?: boolean
  mode?: 'none' | 'hnsw' | 'ivf'
  bm25Enabled?: boolean
  hybridRatio?: number
  embeddingModel?: 'base' | 'qwen3'
}

const SERVER_BASE_URL = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:3000'

export async function searchDocuments(
  query: string,
  options: SearchRequestOptions = {}
): Promise<SearchResponse> {
  const payload = {
    query,
    offset: options.offset ?? 0,
    limit: options.limit ?? 20,
    mode: options.mode ?? 'none',
    bm25Enabled: options.bm25Enabled ?? true,
    hybridRatio: options.hybridRatio ?? 50,
    embeddingModel: options.embeddingModel ?? 'base'
  }

  const endpoint = options.useHybrid ? '/api/search/hybrid' : '/api/search'

  try {
    const response = await fetch(`${SERVER_BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    })

    if (!response.ok) {
      return {
        success: false,
        data: [],
        error: `Request failed with status ${response.status}`
      }
    }

    const parsed = (await response.json()) as SearchResponse
    return parsed
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'

    return {
      success: false,
      data: [],
      error: `Search request failed: ${message}`
    }
  }
}
