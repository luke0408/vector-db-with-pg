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
  idColumn?: string
  docHashColumn?: string | null
  titleColumn?: string
  contentColumn?: string
  textlenColumn?: string
  ftsColumn?: string
  embeddingColumn?: string
  embeddingHnswColumn?: string
  embeddingDim?: number
  embeddingHnswDim?: number
  reductionMethod?: string
  description?: string
  initializeData?: boolean
  makeDefault?: boolean
}

export interface RegisterExistingTableResult {
  table: ManagedTableSummary
  initializedData: boolean
  bm25LanguageStatus: Bm25LanguageStatus
}

export interface Bm25SettingsUpdateRequest {
  k1?: number
  b?: number
}

export interface ManagedDocumentUpsertRequest {
  docHash?: string | null
  title?: string | null
  content?: string
  embedding?: number[] | null
  embeddingHnsw?: number[] | null
}

export interface ManagedDocumentMutationResult {
  tableName: string
  language: string
  id: number
  taskQueued: boolean
  taskType: 'insert' | 'update' | 'delete'
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
