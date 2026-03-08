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
  tableNameUsed?: string
  languageUsed?: string
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
  tableName?: string
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

export interface Bm25SettingsUpdateRequest {
  k1?: number
  b?: number
}

export interface Bm25IndexingEvent {
  event: 'started' | 'chunk' | 'completed' | 'cancelled' | 'error'
  language: string
  chunkSize: number
  claimedTasks?: number
  affectedDocs?: number
  processedTasks?: number
  remainingTasks?: number
  elapsedMs?: number
  message?: string
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

export interface Bm25IndexingStreamOptions {
  chunkSize: number
  onEvent: (event: Bm25IndexingEvent) => void
  signal?: AbortSignal
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
    tableName: options.tableName,
    mode: options.mode ?? 'none',
    bm25Enabled: options.bm25Enabled ?? true,
    hybridRatio: options.hybridRatio ?? 50,
    embeddingModel: options.embeddingModel ?? 'qwen3'
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

export async function updateBm25Settings(
  language: string,
  payload: Bm25SettingsUpdateRequest
): Promise<ApiEnvelope<Bm25LanguageStatus>> {
  return requestJson<ApiEnvelope<Bm25LanguageStatus>>(
    `/api/admin/bm25/${encodeURIComponent(language)}/settings`,
    {
      method: 'PATCH',
      body: JSON.stringify(payload)
    }
  )
}

export async function runBm25IndexingStream(
  language: string,
  options: Bm25IndexingStreamOptions
): Promise<void> {
  const response = await fetch(
    `${SERVER_BASE_URL}/api/admin/bm25/${encodeURIComponent(language)}/run?chunkSize=${encodeURIComponent(String(options.chunkSize))}`,
    {
      method: 'GET',
      signal: options.signal
    }
  )

  if (!response.ok) {
    throw new Error(`Indexing request failed with status ${response.status}`)
  }

  if (!response.body) {
    throw new Error('Indexing response did not include a stream body')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let pendingEventName = 'message'

  while (true) {
    const chunk = await reader.read()

    if (chunk.done) {
      break
    }

    buffer += decoder.decode(chunk.value, { stream: true })

    while (true) {
      const boundaryIndex = buffer.indexOf('\n\n')

      if (boundaryIndex === -1) {
        break
      }

      const rawEvent = buffer.slice(0, boundaryIndex)
      buffer = buffer.slice(boundaryIndex + 2)

      let data = ''
      for (const line of rawEvent.split('\n')) {
        if (line.startsWith('event:')) {
          pendingEventName = line.slice(6).trim()
        } else if (line.startsWith('data:')) {
          data += line.slice(5).trim()
        }
      }

      if (!data) {
        continue
      }

      const parsed = JSON.parse(data) as Bm25IndexingEvent
      options.onEvent({
        ...parsed,
        event: (parsed.event ?? pendingEventName) as Bm25IndexingEvent['event']
      })
    }
  }
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
