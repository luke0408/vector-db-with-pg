import {
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent
} from 'react'
import {
  Bm25IndexingEvent,
  Bm25LanguageStatus,
  Bm25SettingsUpdateRequest,
  ManagedLanguageSummary,
  ManagedTableSummary,
  SearchLearningData,
  SearchMeta,
  SearchResult,
  getBm25LanguageStatus,
  listAdminLanguages,
  listManagedTables,
  registerExistingTable,
  runBm25IndexingStream,
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

const BM25_CHUNK_SIZE_STORAGE_PREFIX = 'bm25-chunk-size:'

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

const emptyLearning: SearchLearningData = {
  generatedSql: '-- run search to generate SQL',
  executionPlan: {},
  queryExplanation: 'Run a search to view query explanation.'
}

export function App() {
  const [viewMode, setViewMode] = useState<ViewMode>('search')
  const [query, setQuery] = useState('')
  const [searchMode, setSearchMode] = useState<SearchMode>('none')
  const [bm25Enabled, setBm25Enabled] = useState(true)
  const [hybridRatio, setHybridRatio] = useState(50)
  const [selectedTableName, setSelectedTableName] = useState('namuwiki_documents')
  const [showSql, setShowSql] = useState(true)
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
  const [selectedLanguageStatus, setSelectedLanguageStatus] =
    useState<Bm25LanguageStatus | null>(null)
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

  const handleSearch = async (nextOffset: number) => {
    setIsLoading(true)
    setErrorMessage(null)

    const useHybrid =
      searchMode !== 'none' || bm25Enabled || hybridRatio !== 50 || nextOffset > 0

    const response = await searchDocuments(query, {
      offset: nextOffset,
      limit,
      tableName: selectedTableName,
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
    setSelectedTableName(
      tableResponse.data.find((table) => table.isDefault)?.tableName ??
        tableResponse.data[0]?.tableName ??
        'namuwiki_documents'
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

  const handleRegisterNamuWiki = async () => {
    setRegistering(true)
    setAdminError(null)

    const response = await registerExistingTable({
      tableName: 'namuwiki_documents',
      language: selectedLanguage || 'korean',
      initializeData: true,
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
        <header className="header">
          <div className="header-title-group">
            <div className="logo-box">DB</div>
            <div>
              <h1>NamuWiki Vector Search Practice</h1>
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
          <button className="icon-button" type="button" aria-label="help">
            ?
          </button>
        </header>

        {viewMode === 'search' ? (
          <>
            <section className="panel search-panel">
              <div className="search-row">
                <div className="search-input-wrap">
                  <span className="search-icon">Search</span>
                  <input
                    className="search-input"
                    placeholder="Search across NamuWiki articles..."
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={handleQueryKeyDown}
                  />
                </div>
                <button
                  className="primary-button"
                  type="button"
                  aria-label="Run Search"
                  onClick={() => void handleSearch(0)}
                  disabled={isLoading}
                >
                  {isLoading ? 'Searching...' : 'Search'}
                </button>
              </div>

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
                  <p className="block-label">Managed Table</p>
                  <select
                    className="search-table-select"
                    value={selectedTableName}
                    onChange={(event) => setSelectedTableName(event.target.value)}
                  >
                    {managedTables.length > 0 ? (
                      managedTables.map((table) => (
                        <option key={table.tableName} value={table.tableName}>
                          {table.tableName}
                        </option>
                      ))
                    ) : (
                      <option value="namuwiki_documents">namuwiki_documents</option>
                    )}
                  </select>
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
                    type="range"
                    min={0}
                    max={100}
                    value={hybridRatio}
                    onChange={(event) => setHybridRatio(Number(event.target.value))}
                  />
                </div>

                <div className="config-block align-end">
                  <button className="ghost-button" type="button">
                    Update Embeddings
                  </button>
                </div>
              </div>

              {errorMessage ? <p className="error-banner">{errorMessage}</p> : null}
            </section>

            <section className="content-grid">
              <div className="left-column">
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
                  </div>
                </article>
              </div>

              <div className="right-column">
                <div className="results-head">
                  <h2>Search Results</h2>
                  <span>
                    {totalMatches} results • offset {offset}
                  </span>
                </div>

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
                  Register the existing <code>namuwiki_documents</code> table, bootstrap BM25
                  support tables, and inspect language-specific status before Phase 2 cutover.
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
                    <span className="panel-caption">{languages.length} configs</span>
                  </header>
                  <div className="admin-list">
                    {languages.map((language) => (
                      <button
                        key={language.language}
                        type="button"
                        className={
                          selectedLanguage === language.language
                            ? 'admin-list-item active'
                            : 'admin-list-item'
                        }
                        onClick={() => setSelectedLanguage(language.language)}
                      >
                        <div>
                          <strong>{language.language}</strong>
                          <p>{language.tableSuffix}</p>
                        </div>
                        <span>{language.documentCount.toLocaleString()} docs</span>
                      </button>
                    ))}
                    {!languages.length && !adminLoading ? (
                      <p className="empty-state">No Postgres text-search configurations detected.</p>
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
                      <div key={table.tableName} className="admin-card">
                        <div className="admin-card-head">
                          <strong>{table.tableName}</strong>
                          {table.isDefault ? <span className="pill">default</span> : null}
                        </div>
                        <p>
                          lang={table.language} • rows={table.rowCount.toLocaleString()} • hnsw dim=
                          {table.embeddingHnswDim}
                        </p>
                        <small>
                          {table.embeddingColumn} / {table.embeddingHnswColumn} / {table.ftsColumn}
                        </small>
                      </div>
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
                    <strong>BM25 Control Tower</strong>
                    <span className="panel-caption">{selectedLanguage || 'select a language'}</span>
                  </header>

                  {selectedLanguageSummary ? (
                    <div className="admin-metrics-grid">
                      <div>
                        <p>k1 / b</p>
                        <strong>
                          {selectedLanguageSummary.k1.toFixed(2)} / {selectedLanguageSummary.b.toFixed(2)}
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
                      <div className="admin-card">
                        <div className="admin-card-head">
                          <strong>BM25 Settings</strong>
                          <span className="pill">editable</span>
                        </div>
                        <div className="admin-form-grid">
                          <label className="admin-field">
                            <span>k1</span>
                            <input
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
                              type="number"
                              min={1}
                              step={1}
                              value={chunkSizeInput}
                              onChange={(event) => setChunkSizeInput(event.target.value)}
                            />
                          </label>
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
                        <div className="indexing-log">
                          {indexingState.events.length > 0 ? (
                            indexingState.events.map((event, index) => (
                              <div className="indexing-log-item" key={`${event.event}-${index}`}>
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
                          <strong>{selectedLanguageStatus.lengths.totalDocuments.toLocaleString()}</strong>
                        </div>
                        <div>
                          <span>Total length</span>
                          <strong>{selectedLanguageStatus.lengths.totalLength.toLocaleString()}</strong>
                        </div>
                        <div>
                          <span>Average length</span>
                          <strong>{selectedLanguageStatus.lengths.averageLength.toFixed(2)}</strong>
                        </div>
                        <div>
                          <span>Pending / Working / Done</span>
                          <strong>
                            {selectedLanguageStatus.queue.pending} / {selectedLanguageStatus.queue.inProgress} /
                            {' '}
                            {selectedLanguageStatus.queue.completed}
                          </strong>
                        </div>
                        <div>
                          <span>Last indexed</span>
                          <strong>{selectedLanguageStatus.lastIndexedAt ?? 'Not indexed yet'}</strong>
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
