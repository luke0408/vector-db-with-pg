import {
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent
} from 'react'
import {
  Bm25IndexingEvent,
  Bm25LanguageStatus,
  ManagedTableBackfillEvent,
  ManagedTableBackfillStatus,
  Bm25SettingsUpdateRequest,
  ManagedLanguageSummary,
  ManagedTableSummary,
  SearchLearningData,
  SearchMeta,
  SearchResult,
  cancelManagedTableBackfill,
  getBm25LanguageStatus,
  getManagedTableBackfillStatus,
  initializeManagedTableBackfill,
  listAdminLanguages,
  listManagedTables,
  registerExistingTable,
  runBm25IndexingStream,
  runManagedTableBackfillStream,
  searchDocuments,
  updateBm25Settings,
} from './lib/search-api'
import { formatSnippet } from './lib/snippet-format'

type SearchMode = 'none' | 'hnsw' | 'ivf'
type ViewMode = 'search' | 'admin'
type IndexingRunState = {
  isRunning: boolean
  events: Bm25IndexingEvent[]
}

type BackfillRunState = {
  isRunning: boolean
  events: ManagedTableBackfillEvent[]
}

const BM25_CHUNK_SIZE_STORAGE_PREFIX = 'bm25-chunk-size:'
const BACKFILL_CHUNK_SIZE_STORAGE_PREFIX = 'backfill-chunk-size:'

function readChunkSizePreference(language: string): string {
  if (
    typeof window === 'undefined' ||
    typeof window.localStorage?.getItem !== 'function'
  ) {
    return '100'
  }

  return (
    window.localStorage.getItem(`${BM25_CHUNK_SIZE_STORAGE_PREFIX}${language}`) ??
    '100'
  )
}

function writeChunkSizePreference(language: string, chunkSize: number): void {
  if (
    typeof window === 'undefined' ||
    typeof window.localStorage?.setItem !== 'function'
  ) {
    return
  }

  window.localStorage.setItem(
    `${BM25_CHUNK_SIZE_STORAGE_PREFIX}${language}`,
    String(chunkSize)
  )
}

function readBackfillChunkSizePreference(tableName: string): string {
  if (
    typeof window === 'undefined' ||
    typeof window.localStorage?.getItem !== 'function'
  ) {
    return '500'
  }

  return (
    window.localStorage.getItem(
      `${BACKFILL_CHUNK_SIZE_STORAGE_PREFIX}${tableName}`
    ) ?? '500'
  )
}

function writeBackfillChunkSizePreference(
  tableName: string,
  chunkSize: number
): void {
  if (
    typeof window === 'undefined' ||
    typeof window.localStorage?.setItem !== 'function'
  ) {
    return
  }

  window.localStorage.setItem(
    `${BACKFILL_CHUNK_SIZE_STORAGE_PREFIX}${tableName}`,
    String(chunkSize)
  )
}

const emptyLearning: SearchLearningData = {
  generatedSql: '-- run search to generate SQL',
  executionPlan: {},
  queryExplanation: 'Run a search to view query explanation.'
}

function formatCoverage(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`
}

function toPercent(processed: number, total: number, fallback = 0): number {
  if (total <= 0) {
    return Math.max(0, Math.min(100, fallback))
  }

  return Math.max(0, Math.min(100, Math.round((processed / total) * 100)))
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) {
    return 'Not available'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  return date.toLocaleString()
}

function getSearchEligibilityMessage(table: ManagedTableSummary | null): string {
  if (!table) {
    return 'No managed table is available yet.'
  }

  if (table.searchEligible) {
    return `Ready for search · embedding ${formatCoverage(table.embeddingCoverage)} · FTS ${formatCoverage(table.ftsCoverage)}`
  }

  const issues: string[] = []

  if (!table.embeddingReady) {
    issues.push(`embedding ${formatCoverage(table.embeddingCoverage)}`)
  }

  if (!table.ftsReady) {
    issues.push(`FTS ${formatCoverage(table.ftsCoverage)}`)
  }

  if (!table.bm25Ready) {
    issues.push('BM25 pending')
  }

  if (table.backfill.status === 'running') {
    issues.push('backfill running')
  }

  if (table.backfill.status === 'error' && table.backfill.lastError) {
    issues.push('backfill error')
  }

  return issues.length > 0
    ? `Search blocked until ${issues.join(', ')}.`
    : 'Search blocked until table readiness checks pass.'
}

function getToneClass(tone: 'neutral' | 'warning' | 'success' | 'error'): string {
  switch (tone) {
    case 'success':
      return 'tone-success'
    case 'warning':
      return 'tone-warning'
    case 'error':
      return 'tone-error'
    default:
      return 'tone-neutral'
  }
}

function getBackfillEventTone(
  event: ManagedTableBackfillEvent['event']
): 'neutral' | 'warning' | 'success' | 'error' {
  switch (event) {
    case 'completed':
      return 'success'
    case 'cancelled':
      return 'warning'
    case 'error':
      return 'error'
    default:
      return 'neutral'
  }
}

function getIndexingEventTone(
  event: Bm25IndexingEvent['event']
): 'neutral' | 'warning' | 'success' | 'error' {
  switch (event) {
    case 'completed':
      return 'success'
    case 'cancelled':
      return 'warning'
    case 'error':
      return 'error'
    default:
      return 'neutral'
  }
}

export function App() {
  const [viewMode, setViewMode] = useState<ViewMode>('search')
  const [query, setQuery] = useState('')
  const [searchMode, setSearchMode] = useState<SearchMode>('none')
  const [bm25Enabled, setBm25Enabled] = useState(true)
  const [hybridRatio, setHybridRatio] = useState(50)
  const [selectedTableName, setSelectedTableName] = useState('namuwiki_documents')
  const [showSql, setShowSql] = useState(false)
  const [showPlan, setShowPlan] = useState(false)
  const [showExplanation, setShowExplanation] = useState(true)
  const [offset, setOffset] = useState(0)
  const [limit] = useState(10)
  const [results, setResults] = useState<SearchResult[]>([])
  const [learning, setLearning] = useState<SearchLearningData>(emptyLearning)
  const [meta, setMeta] = useState<SearchMeta | undefined>()
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [sqlCopied, setSqlCopied] = useState(false)
  const [planCopied, setPlanCopied] = useState(false)

  const [languages, setLanguages] = useState<ManagedLanguageSummary[]>([])
  const [managedTables, setManagedTables] = useState<ManagedTableSummary[]>([])
  const [selectedLanguage, setSelectedLanguage] = useState<string>('')
  const [selectedAdminTableName, setSelectedAdminTableName] = useState<string>('')
  const [selectedLanguageStatus, setSelectedLanguageStatus] =
    useState<Bm25LanguageStatus | null>(null)
  const [selectedTableBackfillStatus, setSelectedTableBackfillStatus] =
    useState<ManagedTableBackfillStatus | null>(null)
  const [adminError, setAdminError] = useState<string | null>(null)
  const [adminLoading, setAdminLoading] = useState(false)
  const [registering, setRegistering] = useState(false)
  const [bm25SettingsDraft, setBm25SettingsDraft] =
    useState<Bm25SettingsUpdateRequest>({})
  const [savingBm25Settings, setSavingBm25Settings] = useState(false)
  const [chunkSizeInput, setChunkSizeInput] = useState('100')
  const [indexingState, setIndexingState] = useState<IndexingRunState>({
    isRunning: false,
    events: []
  })
  const [indexingAbortController, setIndexingAbortController] =
    useState<AbortController | null>(null)
  const [backfillChunkSizeInput, setBackfillChunkSizeInput] = useState('500')
  const [initializingBackfill, setInitializingBackfill] = useState(false)
  const [backfillState, setBackfillState] = useState<BackfillRunState>({
    isRunning: false,
    events: []
  })
  const [backfillAbortController, setBackfillAbortController] =
    useState<AbortController | null>(null)
  const [showAllBackfillEvents, setShowAllBackfillEvents] = useState(false)
  const [showAllIndexingEvents, setShowAllIndexingEvents] = useState(false)

  const totalMatches = meta?.total ?? results.length
  const searchTime = meta?.tookMs ?? 0
  const vectorScore = useMemo(() => {
    if (results.length === 0) {
      return 0
    }

    return Number(results[0].score.toFixed(3))
  }, [results])

  const bm25Score = useMemo(() => {
    if (!bm25Enabled) {
      return 0
    }

    return Number((1 - vectorScore).toFixed(3))
  }, [bm25Enabled, vectorScore])

  const topKeywordSignals = useMemo(
    () => (learning.keywordSignals ?? []).slice(0, 5),
    [learning.keywordSignals]
  )
  const eligibleSearchTables = useMemo(
    () => managedTables.filter((table) => table.searchEligible),
    [managedTables]
  )
  const selectedSearchTable =
    managedTables.find((table) => table.tableName === selectedTableName) ?? null
  const selectedAdminTable =
    managedTables.find((table) => table.tableName === selectedAdminTableName) ?? null
  const effectiveBackfillStatus =
    selectedTableBackfillStatus &&
    selectedTableBackfillStatus.tableName === selectedAdminTableName
      ? selectedTableBackfillStatus
      : selectedAdminTable?.backfill ?? null
  const searchBlockedMessage =
    selectedSearchTable && !selectedSearchTable.searchEligible
      ? getSearchEligibilityMessage(selectedSearchTable)
      : managedTables.length > 0 && eligibleSearchTables.length === 0
        ? 'No search-eligible managed table is available yet.'
        : null
  const liveAnnouncement = useMemo(() => {
    const latestBackfillMessage = backfillState.events.at(-1)?.message
    const latestIndexingMessage = indexingState.events.at(-1)?.message

    return (
      adminError ??
      errorMessage ??
      latestBackfillMessage ??
      latestIndexingMessage ??
      searchBlockedMessage ??
      ''
    )
  }, [
    adminError,
    errorMessage,
    backfillState.events,
    indexingState.events,
    searchBlockedMessage
  ])
  const effectiveBackfillProcessed =
    effectiveBackfillStatus?.processedRows ?? selectedAdminTable?.backfill.processedRows ?? 0
  const effectiveBackfillTotal =
    effectiveBackfillStatus?.totalRows ?? selectedAdminTable?.backfill.totalRows ?? 0
  const backfillProgressPercent = toPercent(
    effectiveBackfillProcessed,
    effectiveBackfillTotal,
    selectedAdminTable?.embeddingReady && selectedAdminTable?.ftsReady ? 100 : 0
  )
  const bm25TaskTotal =
    (selectedLanguageStatus?.queue.pending ?? 0) +
    (selectedLanguageStatus?.queue.inProgress ?? 0) +
    (selectedLanguageStatus?.queue.completed ?? 0)
  const bm25ProgressPercent = toPercent(
    selectedLanguageStatus?.queue.completed ?? 0,
    bm25TaskTotal,
    selectedAdminTable?.bm25Ready ? 100 : 0
  )
  const visibleBackfillEvents = useMemo(
    () =>
      showAllBackfillEvents ? backfillState.events : backfillState.events.slice(-5),
    [backfillState.events, showAllBackfillEvents]
  )
  const visibleIndexingEvents = useMemo(
    () =>
      showAllIndexingEvents ? indexingState.events : indexingState.events.slice(-5),
    [indexingState.events, showAllIndexingEvents]
  )
  const nextOperationalAction = useMemo(() => {
    if (!selectedAdminTable) {
      return {
        title: 'Select a managed table',
        description: 'Choose a table to see the next required search-readiness action.',
        tone: 'neutral' as const
      }
    }

    if (!selectedAdminTable.embeddingReady || !selectedAdminTable.ftsReady) {
      return {
        title: 'Step 1 · Run table backfill',
        description:
          'Backfill will populate embedding_hnsw, fts, and textlen before this table can become search-ready.',
        tone: 'warning' as const
      }
    }

    if (!selectedAdminTable.bm25Ready) {
      return {
        title: 'Step 2 · Run BM25 indexing',
        description:
          'BM25 snapshot/indexing is still pending. Complete indexing to unlock search eligibility.',
        tone: 'warning' as const
      }
    }

    return {
      title: 'Search-ready',
      description:
        'This table now satisfies embedding, FTS, and BM25 readiness and can be used in search.',
      tone: 'success' as const
    }
  }, [selectedAdminTable])

  useEffect(() => {
    void loadManagedTablesForSearch()
  }, [])

  useEffect(() => {
    if (viewMode !== 'admin') {
      return
    }

    void loadAdminOverview()
  }, [viewMode])

  useEffect(() => {
    if (viewMode !== 'admin' || !selectedLanguage) {
      return
    }

    void loadSelectedLanguageStatus(selectedLanguage)
  }, [viewMode, selectedLanguage])

  useEffect(() => {
    if (viewMode !== 'admin' || !selectedAdminTableName) {
      return
    }

    void loadSelectedTableBackfillStatus(selectedAdminTableName)
  }, [viewMode, selectedAdminTableName])

  useEffect(() => {
    if (!selectedLanguageStatus) {
      return
    }

    setBm25SettingsDraft({
      k1: selectedLanguageStatus.k1,
      b: selectedLanguageStatus.b
    })
  }, [selectedLanguageStatus])

  useEffect(() => {
    if (!selectedLanguage) {
      return
    }

    setChunkSizeInput(readChunkSizePreference(selectedLanguage))
    setIndexingState({
      isRunning: false,
      events: []
    })
    setIndexingAbortController(null)
  }, [selectedLanguage])

  useEffect(() => {
    if (!selectedAdminTableName) {
      return
    }

    setBackfillChunkSizeInput(readBackfillChunkSizePreference(selectedAdminTableName))
    setBackfillState({
      isRunning: false,
      events: []
    })
    setBackfillAbortController(null)
  }, [selectedAdminTableName])

  useEffect(() => {
    if (!managedTables.length || selectedSearchTable?.searchEligible) {
      return
    }

    const fallbackEligibleTable = managedTables.find((table) => table.searchEligible)

    if (fallbackEligibleTable && fallbackEligibleTable.tableName !== selectedTableName) {
      setSelectedTableName(fallbackEligibleTable.tableName)
    }
  }, [managedTables, selectedSearchTable, selectedTableName])

  const handleSearch = async (nextOffset: number) => {
    if (!selectedSearchTable?.searchEligible) {
      setErrorMessage(
        searchBlockedMessage ??
          'Select a search-eligible managed table before running search.'
      )
      return
    }

    setIsLoading(true)
    setErrorMessage(null)

    const useHybrid =
      searchMode !== 'none' || bm25Enabled || hybridRatio !== 50 || nextOffset > 0

    const response = await searchDocuments(query, {
      offset: nextOffset,
      limit,
      tableName: selectedSearchTable.tableName,
      useHybrid,
      mode: searchMode,
      bm25Enabled,
      hybridRatio,
      embeddingModel: 'qwen3'
    })

    if (!response.success) {
      setErrorMessage(response.error ?? 'Search request failed')
      setIsLoading(false)
      return
    }

    const payload = response.data[0]

    if (!payload) {
      setResults([])
      setLearning(emptyLearning)
      setMeta(response.meta)
      setOffset(nextOffset)
      setIsLoading(false)
      return
    }

    setResults(payload.items)
    setLearning(payload.learning)
    setMeta(response.meta)
    setOffset(nextOffset)
    setIsLoading(false)
  }

  const loadManagedTablesForSearch = async () => {
    const response = await listManagedTables()

    if (!response.success) {
      return
    }

    setManagedTables(response.data)

    const nextDefaultTable =
      response.data.find((table) => table.isDefault && table.searchEligible)?.tableName ??
      response.data.find((table) => table.searchEligible)?.tableName ??
      response.data.find((table) => table.isDefault)?.tableName ??
      response.data[0]?.tableName ??
      'namuwiki_documents'
    setSelectedTableName((current) => current || nextDefaultTable)
  }

  const loadAdminOverview = async () => {
    setAdminLoading(true)
    setAdminError(null)

    const [languageResponse, tableResponse] = await Promise.all([
      listAdminLanguages(),
      listManagedTables()
    ])

    if (!languageResponse.success) {
      setAdminError(languageResponse.error ?? 'Failed to load admin languages')
      setAdminLoading(false)
      return
    }

    if (!tableResponse.success) {
      setAdminError(tableResponse.error ?? 'Failed to load managed tables')
      setAdminLoading(false)
      return
    }

    setLanguages(languageResponse.data)
    setManagedTables(tableResponse.data)
    setSelectedTableName((current) =>
      current && tableResponse.data.some((table) => table.tableName === current)
        ? current
        : tableResponse.data.find((table) => table.isDefault && table.searchEligible)?.tableName ??
          tableResponse.data.find((table) => table.searchEligible)?.tableName ??
          tableResponse.data.find((table) => table.isDefault)?.tableName ??
          tableResponse.data[0]?.tableName ??
          'namuwiki_documents'
    )
    setSelectedAdminTableName((current) =>
      current && tableResponse.data.some((table) => table.tableName === current)
        ? current
        : tableResponse.data.find((table) => table.isDefault)?.tableName ??
          tableResponse.data[0]?.tableName ??
          'namuwiki_documents'
    )
    setSelectedTableBackfillStatus((current) =>
      current
        ? tableResponse.data.find((table) => table.tableName === current.tableName)?.backfill ??
          current
        : null
    )

    if (languageResponse.data.length > 0) {
      const nextLanguage =
        languageResponse.data.find((item) => item.language === selectedLanguage)?.language ??
        languageResponse.data[0].language
      setSelectedLanguage(nextLanguage)
    } else {
      setSelectedLanguage('')
      setSelectedLanguageStatus(null)
    }

    setAdminLoading(false)
  }

  const loadSelectedLanguageStatus = async (language: string) => {
    const response = await getBm25LanguageStatus(language)

    if (!response.success) {
      setAdminError(response.error ?? 'Failed to load selected language status')
      return
    }

    setSelectedLanguageStatus(response.data[0] ?? null)
  }

  const loadSelectedTableBackfillStatus = async (tableName: string) => {
    const response = await getManagedTableBackfillStatus(tableName)

    if (!response.success) {
      setAdminError(response.error ?? 'Failed to load managed table backfill status')
      return
    }

    setSelectedTableBackfillStatus(response.data[0] ?? null)
  }

  const handleRegisterNamuWiki = async () => {
    setRegistering(true)
    setAdminError(null)

    const response = await registerExistingTable({
      tableName: 'namuwiki_documents',
      language: selectedLanguage || 'korean',
      makeDefault: true
    })

    if (!response.success) {
      setAdminError(response.error ?? 'Failed to register namuwiki_documents')
      setRegistering(false)
      return
    }

    const result = response.data[0]

    if (result) {
      setSelectedLanguage(result.bm25LanguageStatus.language)
      setSelectedLanguageStatus(result.bm25LanguageStatus)
    }

    await loadAdminOverview()
    setRegistering(false)
  }

  const handleSaveBm25Settings = async () => {
    if (!selectedLanguage) {
      return
    }

    setSavingBm25Settings(true)
    setAdminError(null)

    const response = await updateBm25Settings(selectedLanguage, bm25SettingsDraft)

    if (!response.success) {
      setAdminError(response.error ?? 'Failed to update BM25 settings')
      setSavingBm25Settings(false)
      return
    }

    const nextStatus = response.data[0] ?? null
    setSelectedLanguageStatus(nextStatus)
    await loadAdminOverview()
    setSavingBm25Settings(false)
  }

  const handleRunBm25Indexing = async () => {
    if (!selectedLanguage) {
      return
    }

    const parsedChunkSize = Number(chunkSizeInput)

    if (!Number.isInteger(parsedChunkSize) || parsedChunkSize <= 0) {
      setAdminError('Chunk size must be a positive integer.')
      return
    }

    writeChunkSizePreference(selectedLanguage, parsedChunkSize)

    const controller = new AbortController()
    setIndexingAbortController(controller)
    setIndexingState({
      isRunning: true,
      events: []
    })
    setAdminError(null)

    try {
      await runBm25IndexingStream(selectedLanguage, {
        chunkSize: parsedChunkSize,
        signal: controller.signal,
        onEvent: (event) => {
          setIndexingState((current) => ({
            isRunning:
              event.event !== 'completed' &&
              event.event !== 'cancelled' &&
              event.event !== 'error',
            events: [...current.events, event]
          }))
        }
      })
    } catch (error) {
      if (
        !(error instanceof DOMException && error.name === 'AbortError')
      ) {
        setAdminError(
          error instanceof Error ? error.message : 'Failed to run BM25 indexing'
        )
        setIndexingState((current) => ({
          isRunning: false,
          events: [
            ...current.events,
            {
              event: 'error',
              language: selectedLanguage,
              chunkSize: parsedChunkSize,
              message:
                error instanceof Error
                  ? error.message
                  : 'Failed to run BM25 indexing'
            }
          ]
        }))
      }
    } finally {
      setIndexingAbortController(null)
      setIndexingState((current) => ({
        ...current,
        isRunning: false
      }))
      await loadAdminOverview()
      await loadSelectedLanguageStatus(selectedLanguage)
    }
  }

  const handleCancelBm25Indexing = () => {
    indexingAbortController?.abort()
    setIndexingAbortController(null)
    setIndexingState((current) => ({
      isRunning: false,
      events: [
        ...current.events,
        {
          event: 'cancelled',
          language: selectedLanguage || 'unknown',
          chunkSize: Number(chunkSizeInput) || 100,
          message: 'Cancelled from admin UI.'
        }
      ]
    }))
  }

  const handleInitializeBackfill = async () => {
    if (!selectedAdminTableName) {
      return
    }

    setInitializingBackfill(true)
    setAdminError(null)

    const response = await initializeManagedTableBackfill(selectedAdminTableName)

    if (!response.success) {
      setAdminError(response.error ?? 'Failed to initialize table backfill')
      setInitializingBackfill(false)
      return
    }

    setSelectedTableBackfillStatus(response.data[0] ?? null)
    await loadAdminOverview()
    await loadSelectedTableBackfillStatus(selectedAdminTableName)
    setInitializingBackfill(false)
  }

  const handleRunTableBackfill = async () => {
    if (!selectedAdminTableName) {
      return
    }

    const parsedChunkSize = Number(backfillChunkSizeInput)

    if (!Number.isInteger(parsedChunkSize) || parsedChunkSize <= 0) {
      setAdminError('Backfill chunk size must be a positive integer.')
      return
    }

    writeBackfillChunkSizePreference(selectedAdminTableName, parsedChunkSize)

    const controller = new AbortController()
    setBackfillAbortController(controller)
    setBackfillState({
      isRunning: true,
      events: []
    })
    setAdminError(null)

    try {
      await runManagedTableBackfillStream(selectedAdminTableName, {
        chunkSize: parsedChunkSize,
        signal: controller.signal,
        onEvent: (event) => {
          setBackfillState((current) => ({
            isRunning:
              event.event !== 'completed' &&
              event.event !== 'cancelled' &&
              event.event !== 'error',
            events: [...current.events, event]
          }))
        }
      })
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setAdminError(
          error instanceof Error ? error.message : 'Failed to run managed table backfill'
        )
        setBackfillState((current) => ({
          isRunning: false,
          events: [
            ...current.events,
            {
              event: 'error',
              tableName: selectedAdminTableName,
              chunkSize: parsedChunkSize,
              message:
                error instanceof Error
                  ? error.message
                  : 'Failed to run managed table backfill'
            }
          ]
        }))
      }
    } finally {
      setBackfillAbortController(null)
      setBackfillState((current) => ({
        ...current,
        isRunning: false
      }))
      await loadAdminOverview()
      await loadSelectedTableBackfillStatus(selectedAdminTableName)
    }
  }

  const handleCancelTableBackfill = async () => {
    if (!selectedAdminTableName) {
      return
    }

    backfillAbortController?.abort()
    setBackfillAbortController(null)

    const response = await cancelManagedTableBackfill(selectedAdminTableName)

    if (!response.success) {
      setAdminError(response.error ?? 'Failed to cancel managed table backfill')
    } else {
      setSelectedTableBackfillStatus(response.data[0] ?? null)
    }

    setBackfillState((current) => ({
      isRunning: false,
      events: [
        ...current.events,
        {
          event: 'cancelled',
          tableName: selectedAdminTableName,
          chunkSize: Number(backfillChunkSizeInput) || 500,
          message: 'Cancelled from admin UI.'
        }
      ]
    }))

    await loadAdminOverview()
  }

  const handleQueryKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || isLoading) {
      return
    }

    void handleSearch(0)
  }

  const executionPlanText = useMemo(
    () => JSON.stringify(learning.executionPlan, null, 2),
    [learning.executionPlan]
  )

  const selectedLanguageSummary = languages.find(
    (language) => language.language === selectedLanguage
  )

  const handleCopy = async (
    text: string,
    setCopied: (value: boolean) => void
  ) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }

  return (
    <main className="app-shell">
      <div className="container">
        <div className="sr-only-live" aria-live="polite" role="status">
          {liveAnnouncement}
        </div>

        <header className="header">
          <div className="header-title-group">
            <div className="logo-box">DB</div>
            <div>
              <h1>NamuWiki Vector Search Practice</h1>
              <p className="header-subtitle">
                Search and operate managed tables with explicit readiness gates.
              </p>
              <div className="tab-switch" role="tablist" aria-label="workspace switcher">
                <button
                  type="button"
                  className={viewMode === 'search' ? 'tab active' : 'tab'}
                  onClick={() => setViewMode('search')}
                >
                  Search
                </button>
                <button
                  type="button"
                  className={viewMode === 'admin' ? 'tab active' : 'tab'}
                  onClick={() => setViewMode('admin')}
                >
                  Admin
                </button>
              </div>
            </div>
          </div>
          <div className="header-meta">
            <span className="header-pill">
              {selectedSearchTable?.searchEligible ? 'Search ready' : 'Readiness gated'}
            </span>
          </div>
        </header>

        {viewMode === 'search' ? (
          <>
            <section className="panel search-panel">
              <div className="search-panel-head">
                <div>
                  <p className="section-kicker">Search workspace</p>
                  <h2>Run hybrid search against managed tables</h2>
                  <p className="section-description">
                    Search only uses <code>embedding_hnsw</code> and blocks tables that are not
                    fully ready.
                  </p>
                </div>
                <div
                  className={`status-callout compact ${
                    selectedSearchTable?.searchEligible
                      ? getToneClass('success')
                      : getToneClass('warning')
                  }`}
                >
                  <div>
                    <p className="status-callout-kicker">Selected table</p>
                    <strong>{selectedSearchTable?.tableName ?? 'No table selected'}</strong>
                    <p>
                      {selectedSearchTable
                        ? `${selectedSearchTable.language} · ${formatCoverage(
                            selectedSearchTable.embeddingCoverage
                          )} embedding · ${formatCoverage(
                            selectedSearchTable.ftsCoverage
                          )} FTS`
                        : 'Choose a table to search.'}
                    </p>
                  </div>
                </div>
              </div>

              <div className="search-row">
                <label className="search-field" htmlFor="search-query">
                  <span className="block-label">Search query</span>
                  <div className="search-input-wrap">
                    <span className="search-icon">Search</span>
                    <input
                      id="search-query"
                      className="search-input"
                      placeholder="Search across NamuWiki articles..."
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      onKeyDown={handleQueryKeyDown}
                      aria-describedby="search-query-help"
                    />
                  </div>
                </label>
                <button
                  className="primary-button"
                  type="button"
                  aria-label="Run Search"
                  onClick={() => void handleSearch(0)}
                  disabled={isLoading || !selectedSearchTable?.searchEligible}
                >
                  {isLoading ? 'Searching...' : 'Search'}
                </button>
              </div>
              <p id="search-query-help" className="field-hint">
                Search-ready tables only. Use Admin to backfill and index blocked tables.
              </p>

              <div className="config-grid">
                <div className="config-block">
                  <p className="block-label">Vector Search Mode</p>
                  <div className="mode-switch">
                    {(['none', 'hnsw', 'ivf'] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        className={searchMode === mode ? 'mode active' : 'mode'}
                        onClick={() => setSearchMode(mode)}
                      >
                        {mode === 'none' ? 'None' : mode.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="config-block">
                  <label className="block-label" htmlFor="managed-table-select">
                    Managed Table
                  </label>
                  <select
                    id="managed-table-select"
                    className="search-table-select"
                    value={selectedTableName}
                    onChange={(event) => setSelectedTableName(event.target.value)}
                    aria-label="Managed Table"
                  >
                    {managedTables.length > 0 ? (
                      managedTables.map((table) => (
                        <option
                          key={table.tableName}
                          value={table.tableName}
                          disabled={!table.searchEligible}
                        >
                          {table.tableName}
                          {table.isDefault ? ' · default' : ''}
                          {table.searchEligible ? '' : ' · blocked'}
                        </option>
                      ))
                    ) : (
                      <option value="namuwiki_documents">No managed tables</option>
                    )}
                  </select>
                  <p
                    className={
                      selectedSearchTable?.searchEligible
                        ? 'field-hint field-hint-success'
                        : 'field-hint field-hint-warning'
                    }
                  >
                    {selectedSearchTable
                      ? getSearchEligibilityMessage(selectedSearchTable)
                      : 'No managed table selected.'}
                  </p>
                </div>

                <div className="config-block inline-toggle">
                  <label htmlFor="bm25-toggle">Enable BM25 (Full Text)</label>
                  <input
                    id="bm25-toggle"
                    type="checkbox"
                    checked={bm25Enabled}
                    onChange={(event) => setBm25Enabled(event.target.checked)}
                  />
                </div>

                <div className="config-block">
                  <div className="hybrid-label">
                    <span>Keyword</span>
                    <span>Semantic</span>
                  </div>
                  <input
                    aria-label="Hybrid ratio"
                    type="range"
                    min={0}
                    max={100}
                    value={hybridRatio}
                    onChange={(event) => setHybridRatio(Number(event.target.value))}
                  />
                  <p className="field-hint">
                    Semantic {hybridRatio}% · Keyword {100 - hybridRatio}%
                  </p>
                </div>
              </div>

              <div className="search-summary-grid">
                <div className="search-summary-card">
                  <span>Search eligible</span>
                  <strong>{selectedSearchTable?.searchEligible ? 'Yes' : 'No'}</strong>
                </div>
                <div className="search-summary-card">
                  <span>Table language</span>
                  <strong>{selectedSearchTable?.language ?? '—'}</strong>
                </div>
                <div className="search-summary-card">
                  <span>Total matches</span>
                  <strong>{totalMatches}</strong>
                </div>
                <div className="search-summary-card">
                  <span>Response time</span>
                  <strong>{searchTime} ms</strong>
                </div>
              </div>

              {searchBlockedMessage ? (
                <div className={`status-callout ${getToneClass('warning')}`}>
                  <div>
                    <p className="status-callout-kicker">Search blocked</p>
                    <strong>This table is not search-ready yet</strong>
                    <p>
                      Step 1: run table backfill. Step 2: run BM25 indexing. Search remains blocked
                      until embedding, FTS, and BM25 are all ready.
                    </p>
                    <small>{searchBlockedMessage}</small>
                  </div>
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() => {
                      setSelectedAdminTableName(selectedSearchTable?.tableName ?? selectedTableName)
                      setViewMode('admin')
                    }}
                  >
                    Open Admin Workspace
                  </button>
                </div>
              ) : null}
              {errorMessage ? <p className="error-banner">{errorMessage}</p> : null}
            </section>

            <section className="content-grid">
              <div className="left-column">
                <article className="panel insight-panel">
                  <header className="panel-title-row">
                    <strong>Search Metrics</strong>
                  </header>
                  <div className="stats-grid">
                    <div>
                      <p>Total matches</p>
                      <strong>{totalMatches}</strong>
                    </div>
                    <div>
                      <p>Response time</p>
                      <strong>{searchTime} ms</strong>
                    </div>
                    <div>
                      <p>Table used</p>
                      <strong>{meta?.tableNameUsed ?? selectedSearchTable?.tableName ?? '—'}</strong>
                    </div>
                    <div>
                      <p>Language</p>
                      <strong>{meta?.languageUsed ?? selectedSearchTable?.language ?? '—'}</strong>
                    </div>
                  </div>
                </article>

                <article className="panel insight-panel">
                  <header className="panel-title-row">
                    <strong>Generated SQL</strong>
                    <div className="panel-actions">
                      <button
                        type="button"
                        onClick={() => void handleCopy(learning.generatedSql, setSqlCopied)}
                      >
                        {sqlCopied ? 'Copied' : 'Copy'}
                      </button>
                      <button type="button" onClick={() => setShowSql((value) => !value)}>
                        {showSql ? 'Hide' : 'Show'}
                      </button>
                    </div>
                  </header>
                  {showSql ? <pre className="code-block">{learning.generatedSql}</pre> : null}
                </article>

                <article className="panel insight-panel">
                  <header className="panel-title-row">
                    <strong>Query Execution Plan</strong>
                    <div className="panel-actions">
                      <button
                        type="button"
                        onClick={() => void handleCopy(executionPlanText, setPlanCopied)}
                      >
                        {planCopied ? 'Copied' : 'Copy'}
                      </button>
                      <button type="button" onClick={() => setShowPlan((value) => !value)}>
                        {showPlan ? 'Hide' : 'Show'}
                      </button>
                    </div>
                  </header>
                  {showPlan ? <pre className="code-block">{executionPlanText}</pre> : null}
                </article>

                <article className="panel insight-panel">
                  <header className="panel-title-row">
                    <strong>Query Explanation</strong>
                    <div className="panel-actions">
                      <button
                        type="button"
                        onClick={() => setShowExplanation((value) => !value)}
                      >
                        {showExplanation ? 'Hide' : 'Show'}
                      </button>
                    </div>
                  </header>
                  {showExplanation ? (
                    <div className="explanation-box">
                      <p>{learning.queryExplanation}</p>
                    </div>
                  ) : null}
                </article>

                <article className="panel insight-panel">
                  <header className="panel-title-row">
                    <strong>Keyword Signals</strong>
                  </header>
                  <div className="tokens-row">
                    <span>Top ranked keywords</span>
                    <div>
                      {topKeywordSignals.length > 0 ? (
                        topKeywordSignals.map((signal) => (
                          <span className="token-chip" key={signal.keyword}>
                            {signal.keyword} · {signal.weight}
                          </span>
                        ))
                      ) : (
                        <span className="token-chip">No keyword signals yet</span>
                      )}
                    </div>
                  </div>
                </article>

                <article className="panel insight-panel">
                  <header className="panel-title-row">
                    <strong>Score Breakdown</strong>
                  </header>
                  <div className="meter-group">
                    <div>
                      <div className="meter-head">
                        <span>Vector score</span>
                        <span>{vectorScore.toFixed(3)}</span>
                      </div>
                      <div className="meter-bg">
                        <div
                          className="meter-fill primary"
                          style={{ width: `${Math.min(vectorScore, 1) * 100}%` }}
                        />
                      </div>
                    </div>
                    <div>
                      <div className="meter-head">
                        <span>Keyword score</span>
                        <span>{bm25Score.toFixed(3)}</span>
                      </div>
                      <div className="meter-bg">
                        <div
                          className="meter-fill secondary"
                          style={{ width: `${Math.min(bm25Score, 1) * 100}%` }}
                        />
                      </div>
                    </div>
                  </div>
                </article>
              </div>

              <div className="right-column">
                <div className="results-head">
                  <div>
                    <h2>Search Results</h2>
                    <span>
                      {totalMatches} results • offset {offset}
                    </span>
                  </div>
                </div>

                {results.length > 0 ? (
                  <div className="results-list">
                    {results.map((result) => (
                      <article key={result.id} className="result-card">
                        <div className="result-top-row">
                          <div>
                            <h3>{result.title}</h3>
                            <p>{result.category ?? 'Unknown category'}</p>
                          </div>
                          <div className="result-score">
                            <span>{result.score.toFixed(3)}</span>
                            <small>
                              {result.matchRate?.toFixed(1) ?? (result.score * 100).toFixed(1)}%
                              match
                            </small>
                          </div>
                        </div>
                        <p className="result-snippet">{formatSnippet(result.snippet)}</p>
                        {result.tags?.length ? (
                          <div className="result-tags">
                            {result.tags.map((tag) => (
                              <span key={`${result.id}-${tag}`}>{tag}</span>
                            ))}
                          </div>
                        ) : null}
                      </article>
                    ))}
                  </div>
                ) : (
                  <article className="panel empty-results-card">
                    <div className="empty-results-content">
                      <p className="section-kicker">Results</p>
                      <strong>{query ? 'No matches yet' : 'Start with a search query'}</strong>
                      <p>
                        {query
                          ? 'Try a different query, tune the hybrid ratio, or confirm that the selected table is search-ready.'
                          : 'Search results, SQL, and ranking explanations will appear here after you run a query.'}
                      </p>
                    </div>
                  </article>
                )}

                {totalMatches > results.length ? (
                  <div className="load-more-wrap">
                    <button
                      className="ghost-button"
                      type="button"
                      onClick={() => void handleSearch(offset + limit)}
                      disabled={isLoading}
                    >
                      Load more
                    </button>
                  </div>
                ) : null}
              </div>
            </section>
          </>
        ) : (
          <section className="admin-grid">
            <article className="panel admin-panel admin-actions-panel">
              <header className="panel-title-row">
                <strong>Managed Search Admin</strong>
                <div className="panel-actions">
                  <button type="button" onClick={() => void loadAdminOverview()}>
                    Refresh
                  </button>
                </div>
              </header>
              <div className="admin-actions-body">
                <p>
                  Register the existing <code>namuwiki_documents</code> table, then follow the
                  readiness workflow: backfill embeddings/FTS first, run BM25 indexing second,
                  enable search only when the table is fully ready.
                </p>
                <div className="admin-actions-row">
                  <button
                    className="primary-button"
                    type="button"
                    onClick={() => void handleRegisterNamuWiki()}
                    disabled={registering || adminLoading}
                  >
                    {registering ? 'Registering...' : 'Register NamuWiki Table'}
                  </button>
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() => void loadAdminOverview()}
                    disabled={adminLoading}
                  >
                    {adminLoading ? 'Refreshing...' : 'Reload Overview'}
                  </button>
                </div>
                {adminError ? <p className="error-banner">{adminError}</p> : null}
              </div>
            </article>

            <div className="admin-columns">
              <div className="left-column">
                <article className="panel admin-panel">
                  <header className="panel-title-row">
                    <strong>Supported Languages</strong>
                    <span className="panel-caption">{languages.length} active</span>
                  </header>
                  <div className="language-pill-row">
                    {languages.map((language) => (
                      <button
                        key={language.language}
                        type="button"
                        className={
                          selectedLanguage === language.language
                            ? 'language-pill active'
                            : 'language-pill'
                        }
                        onClick={() => setSelectedLanguage(language.language)}
                      >
                        <strong>{language.language}</strong>
                        <span>{language.documentCount.toLocaleString()} docs</span>
                      </button>
                    ))}
                    {!languages.length && !adminLoading ? (
                      <p className="empty-state">No supported languages detected.</p>
                    ) : null}
                  </div>
                </article>

                <article className="panel admin-panel">
                  <header className="panel-title-row">
                    <strong>Managed Tables</strong>
                    <span className="panel-caption">{managedTables.length} registered</span>
                  </header>
                  <div className="admin-list">
                    {managedTables.map((table) => (
                      <button
                        key={table.tableName}
                        type="button"
                        className={
                          selectedAdminTableName === table.tableName
                            ? 'admin-card admin-table-card active'
                            : 'admin-card admin-table-card'
                        }
                        onClick={() => setSelectedAdminTableName(table.tableName)}
                      >
                        <div className="admin-card-head">
                          <strong>{table.tableName}</strong>
                          <div className="pill-row">
                            {table.isDefault ? <span className="pill">default</span> : null}
                            <span
                              className={
                                table.searchEligible ? 'pill pill-success' : 'pill pill-warning'
                              }
                            >
                              {table.searchEligible ? 'search ready' : 'blocked'}
                            </span>
                          </div>
                        </div>
                        <p>
                          lang={table.language} • rows={table.rowCount.toLocaleString()} • hnsw dim=
                          {table.embeddingHnswDim}
                        </p>
                        <div className="admin-inline-metrics">
                          <span>Embedding {formatCoverage(table.embeddingCoverage)}</span>
                          <span>FTS {formatCoverage(table.ftsCoverage)}</span>
                          <span>BM25 {table.bm25Ready ? 'ready' : 'pending'}</span>
                          <span>Backfill {table.backfill.status}</span>
                        </div>
                        <small>
                          {table.embeddingColumn} / {table.embeddingHnswColumn} / {table.ftsColumn}
                        </small>
                      </button>
                    ))}
                    {!managedTables.length && !adminLoading ? (
                      <p className="empty-state">No managed tables registered yet.</p>
                    ) : null}
                  </div>
                </article>
              </div>

              <div className="right-column">
                <article className="panel admin-panel">
                  <header className="panel-title-row">
                    <strong>Managed Table Readiness</strong>
                    <span className="panel-caption">
                      {selectedAdminTableName || 'select a table'}
                    </span>
                  </header>

                  {selectedAdminTable ? (
                    <div className="admin-status-detail">
                      <div className={`status-callout ${getToneClass(nextOperationalAction.tone)}`}>
                        <div>
                          <p className="status-callout-kicker">Next action</p>
                          <strong>{nextOperationalAction.title}</strong>
                          <p>{nextOperationalAction.description}</p>
                        </div>
                      </div>

                      <div className="admin-metrics-grid">
                        <div>
                          <p>Embedding coverage</p>
                          <strong>{formatCoverage(selectedAdminTable.embeddingCoverage)}</strong>
                        </div>
                        <div>
                          <p>FTS coverage</p>
                          <strong>{formatCoverage(selectedAdminTable.ftsCoverage)}</strong>
                        </div>
                        <div>
                          <p>BM25 ready</p>
                          <strong>{selectedAdminTable.bm25Ready ? 'Yes' : 'No'}</strong>
                        </div>
                        <div>
                          <p>Search eligible</p>
                          <strong>{selectedAdminTable.searchEligible ? 'Yes' : 'No'}</strong>
                        </div>
                      </div>

                      <div className="step-grid">
                        <article
                          className={`step-card ${
                            selectedAdminTable.embeddingReady && selectedAdminTable.ftsReady
                              ? 'step-card-success'
                              : 'step-card-warning'
                          }`}
                        >
                          <span>Step 1</span>
                          <strong>Backfill table</strong>
                          <p>Populate embedding_hnsw, fts, and textlen.</p>
                        </article>
                        <article
                          className={`step-card ${
                            selectedAdminTable.bm25Ready
                              ? 'step-card-success'
                              : 'step-card-warning'
                          }`}
                        >
                          <span>Step 2</span>
                          <strong>Run BM25 indexing</strong>
                          <p>Generate BM25 token and length support tables.</p>
                        </article>
                        <article
                          className={`step-card ${
                            selectedAdminTable.searchEligible
                              ? 'step-card-success'
                              : 'step-card-neutral'
                          }`}
                        >
                          <span>Step 3</span>
                          <strong>Search enabled</strong>
                          <p>Search becomes available only after all readiness checks pass.</p>
                        </article>
                      </div>

                      <div className="admin-card">
                        <div className="admin-card-head">
                          <strong>Backfill Control</strong>
                          <div className="pill-row">
                            <span className="pill">
                              {effectiveBackfillStatus?.status ?? selectedAdminTable.backfill.status}
                            </span>
                            {selectedAdminTable.isDefault ? (
                              <span className="pill">default</span>
                            ) : null}
                          </div>
                        </div>
                        <div className="admin-form-grid">
                          <label className="admin-field">
                            <span>Backfill chunk size</span>
                            <input
                              aria-label="Backfill chunk size"
                              type="number"
                              min={1}
                              step={1}
                              value={backfillChunkSizeInput}
                              onChange={(event) =>
                                setBackfillChunkSizeInput(event.target.value)
                              }
                            />
                          </label>
                        </div>
                        <div className="progress-card">
                          <div className="progress-head">
                            <span>Backfill progress</span>
                            <strong>{backfillProgressPercent}%</strong>
                          </div>
                          <div className="progress-track">
                            <div
                              className="progress-fill progress-fill-primary"
                              style={{ width: `${backfillProgressPercent}%` }}
                            />
                          </div>
                        </div>
                        <div className="admin-actions-row">
                          <button
                            className="ghost-button"
                            type="button"
                            onClick={() => void handleInitializeBackfill()}
                            disabled={initializingBackfill || backfillState.isRunning}
                          >
                            {initializingBackfill ? 'Preparing...' : 'Prepare Backfill'}
                          </button>
                          <button
                            className="primary-button"
                            type="button"
                            onClick={() => void handleRunTableBackfill()}
                            disabled={backfillState.isRunning || adminLoading}
                          >
                            {backfillState.isRunning ? 'Backfilling...' : 'Run Backfill'}
                          </button>
                          <button
                            className="ghost-button"
                            type="button"
                            onClick={() => void handleCancelTableBackfill()}
                            disabled={!backfillState.isRunning}
                          >
                            Cancel Backfill
                          </button>
                        </div>
                        <div className="info-table">
                          <div>
                            <span>Status</span>
                            <strong>{effectiveBackfillStatus?.status ?? 'idle'}</strong>
                          </div>
                          <div>
                            <span>Progress</span>
                            <strong>
                              {effectiveBackfillProcessed}/{effectiveBackfillTotal}
                            </strong>
                          </div>
                          <div>
                            <span>Remaining</span>
                            <strong>
                              {effectiveBackfillStatus?.remainingRows ??
                                selectedAdminTable.backfill.remainingRows}
                            </strong>
                          </div>
                          <div>
                            <span>Cancel requested</span>
                            <strong>
                              {(effectiveBackfillStatus?.cancelRequested ??
                                selectedAdminTable.backfill.cancelRequested)
                                ? 'Yes'
                                : 'No'}
                            </strong>
                          </div>
                          <div>
                            <span>Last started</span>
                            <strong>
                              {formatTimestamp(
                                effectiveBackfillStatus?.lastStartedAt ??
                                  selectedAdminTable.backfill.lastStartedAt
                              )}
                            </strong>
                          </div>
                          <div>
                            <span>Last completed</span>
                            <strong>
                              {formatTimestamp(
                                effectiveBackfillStatus?.lastCompletedAt ??
                                  selectedAdminTable.backfill.lastCompletedAt
                              )}
                            </strong>
                          </div>
                        </div>
                        <div className="log-toolbar">
                          <strong>Backfill activity</strong>
                          {backfillState.events.length > 5 ? (
                            <button
                              type="button"
                              onClick={() => setShowAllBackfillEvents((value) => !value)}
                            >
                              {showAllBackfillEvents ? 'Show latest' : 'Show all'}
                            </button>
                          ) : null}
                        </div>
                        <div className="indexing-log" aria-live="polite">
                          {visibleBackfillEvents.length > 0 ? (
                            visibleBackfillEvents.map((event, index) => (
                              <div
                                className={`indexing-log-item ${getToneClass(
                                  getBackfillEventTone(event.event)
                                )}`}
                                key={`${event.event}-${index}`}
                              >
                                <strong>{event.event}</strong>
                                <span>
                                  processed={event.processedRows ?? 0} • remaining=
                                  {event.remainingRows ?? 0}
                                  {typeof event.updatedRows === 'number'
                                    ? ` • updated=${event.updatedRows}`
                                    : ''}
                                </span>
                                {event.message ? <small>{event.message}</small> : null}
                              </div>
                            ))
                          ) : (
                            <p className="empty-state">
                              Run backfill to stream embedding/FTS progress for this table.
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="admin-status-detail">
                      <p className="empty-state">
                        Select a managed table to inspect readiness and control backfill.
                      </p>
                    </div>
                  )}
                </article>

                <article className="panel admin-panel">
                  <header className="panel-title-row">
                    <strong>BM25 Control Tower</strong>
                    <span className="panel-caption">{selectedLanguage || 'select a language'}</span>
                  </header>

                  {selectedLanguageSummary ? (
                    <div className="admin-metrics-grid">
                      <div>
                        <p>k1 / b</p>
                        <strong>
                          {selectedLanguageSummary.k1.toFixed(2)} /{' '}
                          {selectedLanguageSummary.b.toFixed(2)}
                        </strong>
                      </div>
                      <div>
                        <p>Queue</p>
                        <strong>
                          {selectedLanguageSummary.pendingTasks +
                            selectedLanguageSummary.inProgressTasks +
                            selectedLanguageSummary.completedTasks}
                        </strong>
                      </div>
                      <div>
                        <p>Tokens</p>
                        <strong>{selectedLanguageSummary.tokenCount.toLocaleString()}</strong>
                      </div>
                      <div>
                        <p>Tables</p>
                        <strong>{selectedLanguageSummary.managedTableCount}</strong>
                      </div>
                    </div>
                  ) : null}

                  {selectedLanguageStatus ? (
                    <div className="admin-status-detail">
                      <div
                        className={`status-callout ${
                          selectedLanguageStatus.queue.pending > 0 ||
                          selectedLanguageStatus.queue.inProgress > 0
                            ? getToneClass('warning')
                            : getToneClass('success')
                        }`}
                      >
                        <div>
                          <p className="status-callout-kicker">Language indexing status</p>
                          <strong>
                            {selectedLanguageStatus.queue.pending > 0 ||
                            selectedLanguageStatus.queue.inProgress > 0
                              ? 'Indexing work is still pending'
                              : 'BM25 language state is up to date'}
                          </strong>
                          <p>
                            Tune <code>k1</code>/<code>b</code>, then run indexing to process any
                            queued BM25 work.
                          </p>
                        </div>
                      </div>

                      <div className="admin-card">
                        <div className="admin-card-head">
                          <strong>BM25 Settings</strong>
                          <span className="pill">editable</span>
                        </div>
                        <div className="admin-form-grid">
                          <label className="admin-field">
                            <span>k1</span>
                            <input
                              aria-label="k1"
                              type="number"
                              min={0.1}
                              step={0.05}
                              value={bm25SettingsDraft.k1 ?? ''}
                              onChange={(event) =>
                                setBm25SettingsDraft((current) => ({
                                  ...current,
                                  k1: Number(event.target.value)
                                }))
                              }
                            />
                          </label>
                          <label className="admin-field">
                            <span>b</span>
                            <input
                              aria-label="b"
                              type="number"
                              min={0}
                              max={1}
                              step={0.05}
                              value={bm25SettingsDraft.b ?? ''}
                              onChange={(event) =>
                                setBm25SettingsDraft((current) => ({
                                  ...current,
                                  b: Number(event.target.value)
                                }))
                              }
                            />
                          </label>
                        </div>
                        <div className="admin-actions-row">
                          <button
                            className="primary-button"
                            type="button"
                            onClick={() => void handleSaveBm25Settings()}
                            disabled={savingBm25Settings || indexingState.isRunning}
                          >
                            {savingBm25Settings ? 'Saving...' : 'Save BM25 Settings'}
                          </button>
                        </div>
                      </div>

                      <div className="admin-card">
                        <div className="admin-card-head">
                          <strong>Indexing Runner</strong>
                          <span className="pill">{indexingState.isRunning ? 'running' : 'idle'}</span>
                        </div>
                        <div className="admin-form-grid">
                          <label className="admin-field">
                            <span>Chunk size</span>
                            <input
                              aria-label="Chunk size"
                              type="number"
                              min={1}
                              step={1}
                              value={chunkSizeInput}
                              onChange={(event) => setChunkSizeInput(event.target.value)}
                            />
                          </label>
                        </div>
                        <div className="progress-card">
                          <div className="progress-head">
                            <span>Indexing progress</span>
                            <strong>{bm25ProgressPercent}%</strong>
                          </div>
                          <div className="progress-track">
                            <div
                              className="progress-fill progress-fill-success"
                              style={{ width: `${bm25ProgressPercent}%` }}
                            />
                          </div>
                        </div>
                        <div className="admin-actions-row">
                          <button
                            className="primary-button"
                            type="button"
                            onClick={() => void handleRunBm25Indexing()}
                            disabled={indexingState.isRunning || adminLoading}
                          >
                            {indexingState.isRunning ? 'Indexing...' : 'Run Indexing'}
                          </button>
                          <button
                            className="ghost-button"
                            type="button"
                            onClick={handleCancelBm25Indexing}
                            disabled={!indexingState.isRunning}
                          >
                            Cancel
                          </button>
                        </div>
                        <div className="log-toolbar">
                          <strong>Indexing activity</strong>
                          {indexingState.events.length > 5 ? (
                            <button
                              type="button"
                              onClick={() => setShowAllIndexingEvents((value) => !value)}
                            >
                              {showAllIndexingEvents ? 'Show latest' : 'Show all'}
                            </button>
                          ) : null}
                        </div>
                        <div className="indexing-log" aria-live="polite">
                          {visibleIndexingEvents.length > 0 ? (
                            visibleIndexingEvents.map((event, index) => (
                              <div
                                className={`indexing-log-item ${getToneClass(
                                  getIndexingEventTone(event.event)
                                )}`}
                                key={`${event.event}-${index}`}
                              >
                                <strong>{event.event}</strong>
                                <span>
                                  processed={event.processedTasks ?? 0} • remaining=
                                  {event.remainingTasks ?? 0}
                                </span>
                                {event.message ? <small>{event.message}</small> : null}
                              </div>
                            ))
                          ) : (
                            <p className="empty-state">
                              Run indexing to stream chunk progress for this language.
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="info-table">
                        <div>
                          <span>Language</span>
                          <strong>{selectedLanguageStatus.language}</strong>
                        </div>
                        <div>
                          <span>Suffix</span>
                          <strong>{selectedLanguageStatus.tableSuffix}</strong>
                        </div>
                        <div>
                          <span>Managed tables</span>
                          <strong>{selectedLanguageStatus.lengths.managedTables}</strong>
                        </div>
                        <div>
                          <span>Total docs</span>
                          <strong>
                            {selectedLanguageStatus.lengths.totalDocuments.toLocaleString()}
                          </strong>
                        </div>
                        <div>
                          <span>Total length</span>
                          <strong>
                            {selectedLanguageStatus.lengths.totalLength.toLocaleString()}
                          </strong>
                        </div>
                        <div>
                          <span>Average length</span>
                          <strong>{selectedLanguageStatus.lengths.averageLength.toFixed(2)}</strong>
                        </div>
                        <div>
                          <span>Pending / Working / Done</span>
                          <strong>
                            {selectedLanguageStatus.queue.pending} /{' '}
                            {selectedLanguageStatus.queue.inProgress} /{' '}
                            {selectedLanguageStatus.queue.completed}
                          </strong>
                        </div>
                        <div>
                          <span>Last indexed</span>
                          <strong>{formatTimestamp(selectedLanguageStatus.lastIndexedAt)}</strong>
                        </div>
                      </div>
                      <div className="admin-card">
                        <div className="admin-card-head">
                          <strong>Tables using this language</strong>
                        </div>
                        <p>
                          {selectedLanguageStatus.managedTablesUsingLanguage.length
                            ? selectedLanguageStatus.managedTablesUsingLanguage.join(', ')
                            : 'None'}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="admin-status-detail">
                      <p className="empty-state">
                        {adminLoading
                          ? 'Loading admin status...'
                          : 'Select a language to inspect BM25 support tables.'}
                      </p>
                    </div>
                  )}
                </article>
              </div>
            </div>
          </section>
        )}
      </div>
    </main>
  )
}
