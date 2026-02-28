import { useMemo, useState } from 'react'
import {
  SearchLearningData,
  SearchMeta,
  SearchResult,
  searchDocuments
} from './lib/search-api'

type SearchMode = 'none' | 'hnsw' | 'ivf'

const initialResults: SearchResult[] = [
  {
    id: 1,
    title: 'ARM (Architecture)',
    category: 'Computing > Hardware > ISA',
    matchRate: 98.4,
    distance: 0.0124,
    snippet:
      'ARM architecture is a family of reduced instruction set computer architectures for processors across mobile and server platforms.',
    tags: ['RISC', 'Semiconductor', 'Mobile Computing'],
    score: 0.984
  },
  {
    id: 2,
    title: 'Bose Corporation',
    category: 'Technology > Audio',
    matchRate: 89.1,
    distance: 0.1089,
    snippet:
      'Bose Corporation is an American manufacturing company known for home audio systems and active noise-cancelling headphones.',
    tags: ['Audio', 'Consumer Tech'],
    score: 0.891
  }
]

const initialLearning: SearchLearningData = {
  generatedSql: `SELECT title, content,
  vector_distance(embedding, $1) AS dist
FROM namuwiki_articles
WHERE content @@ to_tsquery('english', 'search_term')
ORDER BY dist ASC
LIMIT 5;`,
  executionPlan: {
    Plan: {
      'Node Type': 'Index Scan',
      'Index Name': 'wiki_idx_hnsw',
      'Startup Cost': 0,
      'Total Cost': 12.45,
      'Plan Rows': 5,
      Filter: '(similarity > 0.85)'
    }
  },
  queryExplanation:
    'Planner selected Index Scan using HNSW index for fast nearest-neighbor retrieval.'
}

export function App() {
  const [query, setQuery] = useState('ARM')
  const [searchMode, setSearchMode] = useState<SearchMode>('none')
  const [bm25Enabled, setBm25Enabled] = useState(true)
  const [hybridRatio, setHybridRatio] = useState(50)
  const [showSql, setShowSql] = useState(true)
  const [showPlan, setShowPlan] = useState(false)
  const [showExplanation, setShowExplanation] = useState(true)
  const [offset, setOffset] = useState(0)
  const [limit] = useState(10)
  const [results, setResults] = useState<SearchResult[]>(initialResults)
  const [learning, setLearning] = useState<SearchLearningData>(initialLearning)
  const [meta, setMeta] = useState<SearchMeta | undefined>()
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

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
      hybridRatio
    })

    if (!response.success) {
      setErrorMessage(response.error ?? 'Search request failed')
      setIsLoading(false)
      return
    }

    const payload = response.data[0]

    if (!payload) {
      setResults([])
      setLearning(initialLearning)
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

  const executionPlanText = useMemo(
    () => JSON.stringify(learning.executionPlan, null, 2),
    [learning.executionPlan]
  )

  return (
    <main className="app-shell">
      <div className="container">
        <header className="header">
          <div className="header-title-group">
            <div className="logo-box">DB</div>
            <h1>NamuWiki Vector Search Practice</h1>
          </div>
          <button className="icon-button" type="button" aria-label="help">
            ?
          </button>
        </header>

        <section className="panel search-panel">
          <div className="search-row">
            <div className="search-input-wrap">
              <span className="search-icon">Search</span>
              <input
                className="search-input"
                placeholder="Search across NamuWiki articles..."
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <button
              className="primary-button"
              type="button"
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
                <button type="button" onClick={() => setShowSql((previous) => !previous)}>
                  {showSql ? 'Collapse' : 'Expand'}
                </button>
              </header>
              {showSql ? <pre className="code-block">{learning.generatedSql}</pre> : null}
            </article>

            <article className="panel insight-panel">
              <header className="panel-title-row">
                <strong>Query Execution Plan</strong>
                <button type="button" onClick={() => setShowPlan((previous) => !previous)}>
                  {showPlan ? 'Collapse' : 'Expand'}
                </button>
              </header>
              {showPlan ? <pre className="code-block">{executionPlanText}</pre> : null}
            </article>

            <article className="panel insight-panel">
              <header className="panel-title-row">
                <strong>Query Explanation</strong>
                <button
                  type="button"
                  onClick={() => setShowExplanation((previous) => !previous)}
                >
                  {showExplanation ? 'Collapse' : 'Expand'}
                </button>
              </header>
              {showExplanation ? (
                <div className="explanation-box">
                  <p>{learning.queryExplanation}</p>
                </div>
              ) : null}
            </article>

            <article className="panel insight-panel">
              <header className="panel-title-row">
                <strong>Scoring Breakdown</strong>
              </header>
              <div className="meter-group">
                <div>
                  <div className="meter-head">
                    <span>Vector Similarity Score</span>
                    <span>{vectorScore.toFixed(3)}</span>
                  </div>
                  <div className="meter-bg">
                    <div
                      className="meter-fill primary"
                      style={{ width: `${Math.max(0, Math.min(vectorScore * 100, 100))}%` }}
                    />
                  </div>
                </div>
                <div>
                  <div className="meter-head">
                    <span>BM25 Text Rank Score</span>
                    <span>{bm25Score.toFixed(3)}</span>
                  </div>
                  <div className="meter-bg">
                    <div
                      className="meter-fill secondary"
                      style={{ width: `${Math.max(0, Math.min(bm25Score * 100, 100))}%` }}
                    />
                  </div>
                </div>
              </div>
              <div className="stats-grid">
                <div>
                  <p>Total Matches</p>
                  <strong>{totalMatches}</strong>
                </div>
                <div>
                  <p>Search Time</p>
                  <strong>{searchTime}ms</strong>
                </div>
              </div>
            </article>
          </div>

          <div className="right-column">
            <div className="results-head">
              <h2>Search Results (Offset {offset})</h2>
              <span>Sort by: Hybrid Relevance</span>
            </div>

            <div className="results-list">
              {results.map((result) => (
                <article className="result-card" key={result.id}>
                  <div className="result-top-row">
                    <div>
                      <h3>{result.title}</h3>
                      <p>{result.category ?? 'Unknown'}</p>
                    </div>
                    <div className="result-score">
                      <span>{(result.matchRate ?? result.score * 100).toFixed(1)}% Match</span>
                      <small>
                        dist: {((result.distance ?? 1 - result.score) as number).toFixed(4)}
                      </small>
                    </div>
                  </div>
                  <p className="result-snippet">{result.snippet}</p>
                  <div className="result-tags">
                    {(result.tags ?? ['NamuWiki']).map((tag) => (
                      <span key={`${result.id}-${tag}`}>{tag}</span>
                    ))}
                  </div>
                </article>
              ))}
            </div>

            <div className="load-more-wrap">
              <button
                className="ghost-button"
                type="button"
                onClick={() => void handleSearch(offset + limit)}
                disabled={isLoading}
              >
                Load More Results
              </button>
            </div>
          </div>
        </section>
      </div>
    </main>
  )
}
