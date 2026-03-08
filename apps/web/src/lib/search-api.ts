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

export interface ManagedLanguageSummary {
  language: string
  tableSuffix: string
  k1: number
  b: number
  lastIndexedAt: string | null
  managedTableCount: number
  documentCount: number
  tokenCount: number
  pendingTasks: number
  inProgressTasks: number
  completedTasks: number
}

export interface ManagedTableSummary {
  tableName: string
  language: string
  idColumn: string
  docHashColumn: string | null
  titleColumn: string
  contentColumn: string
  textlenColumn: string
  ftsColumn: string
  embeddingColumn: string
  embeddingHnswColumn: string
  embeddingDim: number
  embeddingHnswDim: number
  reductionMethod: string
  description: string | null
  isDefault: boolean
  isActive: boolean
  rowCount: number
  lastIndexedAt: string | null
}

export interface Bm25LanguageStatus {
  language: string
  tableSuffix: string
  k1: number
  b: number
  lastIndexedAt: string | null
  queue: {
    pending: number
    inProgress: number
    completed: number
  }
  lengths: {
    managedTables: number
    totalDocuments: number
    totalLength: number
    averageLength: number
  }
  tokens: {
    uniqueTokens: number
  }
  managedTablesUsingLanguage: string[]
}

export interface RegisterExistingTableRequest {
  tableName: string
  language?: string
  initializeData?: boolean
  makeDefault?: boolean
}

export interface RegisterExistingTableResult {
  table: ManagedTableSummary
  initializedData: boolean
  bm25LanguageStatus: Bm25LanguageStatus
}

export interface ApiEnvelope<T> {
  success: boolean
  data: T[]
  error?: string
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
  return requestJson<SearchResponse>(endpoint, {
    method: 'POST',
    body: JSON.stringify(payload)
  })
}

export async function listAdminLanguages(): Promise<ApiEnvelope<ManagedLanguageSummary>> {
  return requestJson<ApiEnvelope<ManagedLanguageSummary>>('/api/admin/languages')
}

export async function listManagedTables(): Promise<ApiEnvelope<ManagedTableSummary>> {
  return requestJson<ApiEnvelope<ManagedTableSummary>>('/api/admin/tables')
}

export async function getBm25LanguageStatus(
  language: string
): Promise<ApiEnvelope<Bm25LanguageStatus>> {
  return requestJson<ApiEnvelope<Bm25LanguageStatus>>(
    `/api/admin/bm25/${encodeURIComponent(language)}/status`
  )
}

export async function registerExistingTable(
  payload: RegisterExistingTableRequest
): Promise<ApiEnvelope<RegisterExistingTableResult>> {
  return requestJson<ApiEnvelope<RegisterExistingTableResult>>(
    '/api/admin/tables/register-existing',
    {
      method: 'POST',
      body: JSON.stringify(payload)
    }
  )
}

async function requestJson<T>(
  endpoint: string,
  init: RequestInit = {}
): Promise<T> {
  try {
    const response = await fetch(`${SERVER_BASE_URL}${endpoint}`, {
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers ?? {})
      },
      ...init
    })

    if (!response.ok) {
      return {
        success: false,
        data: [],
        error: `Request failed with status ${response.status}`
      } as T
    }

    return (await response.json()) as T
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return {
      success: false,
      data: [],
      error: `Request failed: ${message}`
    } as T
  }
}
