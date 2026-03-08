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
  embeddingCoverage: number
  ftsCoverage: number
  embeddingReady: boolean
  ftsReady: boolean
  bm25Ready: boolean
  searchEligible: boolean
  backfill: ManagedTableBackfillStatus
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
  makeDefault?: boolean
}

export interface RegisterExistingTableResult {
  table: ManagedTableSummary
  bm25LanguageStatus: Bm25LanguageStatus
}

export type ManagedTableBackfillState =
  | 'idle'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'error'

export interface ManagedTableBackfillStatus {
  tableName: string
  status: ManagedTableBackfillState
  totalRows: number
  processedRows: number
  remainingRows: number
  lastProcessedId: number | null
  cancelRequested: boolean
  lastStartedAt: string | null
  lastCompletedAt: string | null
  lastError: string | null
}

export interface ManagedTableBackfillEvent {
  event: 'started' | 'chunk' | 'completed' | 'cancelled' | 'error'
  tableName: string
  chunkSize: number
  processedRows?: number
  remainingRows?: number
  updatedRows?: number
  elapsedMs?: number
  message?: string
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
