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
