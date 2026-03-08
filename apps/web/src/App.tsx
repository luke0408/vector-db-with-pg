import {
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent
} from 'react'
import {
  Bm25LanguageStatus,
  ManagedLanguageSummary,
  ManagedTableSummary,
  SearchLearningData,
  SearchMeta,
  SearchResult,
  getBm25LanguageStatus,
  listAdminLanguages,
  listManagedTables,
  registerExistingTable,
  searchDocuments
} from './lib/search-api'
import { formatSnippet } from './lib/snippet-format'

type SearchMode = 'none' | 'hnsw' | 'ivf'
type EmbeddingModel = 'base' | 'qwen3'
type ViewMode = 'search' | 'admin'

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
  const [embeddingModel, setEmbeddingModel] = useState<EmbeddingModel>('base')
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

  const handleSearch = async (nextOffset: number) => {
    setIsLoading(true)
    setErrorMessage(null)

    const useHybrid =
      searchMode !== 'none' || bm25Enabled || hybridRatio !== 50 || nextOffset > 0

    const response = await searchDocuments(query, {
      offset: nextOffset,
      limit,
      useHybrid,
      mode: searchMode,
      bm25Enabled,
      hybridRatio,
      embeddingModel
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
                  <p className="block-label">Embedding Model</p>
                  <div className="mode-switch">
                    {(['base', 'qwen3'] as const).map((model) => (
                      <button
                        key={model}
                        type="button"
                        className={embeddingModel === model ? 'mode active' : 'mode'}
                        onClick={() => setEmbeddingModel(model)}
                      >
                        {model === 'base' ? 'BASE (384)' : 'QWEN3 (1024)'}
                      </button>
                    ))}
                  </div>
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
                <strong>Phase 1 Managed Search Admin</strong>
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
                    <strong>BM25 Status</strong>
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
