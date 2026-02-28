import { FormEvent, useMemo, useState } from 'react'
import { searchDocuments, SearchResult } from './lib/search-api'

function sampleRows(): SearchResult[] {
  return [
    {
      id: 1,
      title: '무궁화 꽃이 피었습니다',
      snippet: '나무위키 문서 일부 샘플 텍스트입니다.',
      score: 0.912
    },
    {
      id: 2,
      title: '대한민국 상징',
      snippet: '벡터 검색 학습용 샘플 결과를 표시합니다.',
      score: 0.865
    }
  ]
}

export function App() {
  const [query, setQuery] = useState('무궁화 꽃')
  const [results, setResults] = useState<SearchResult[]>(sampleRows)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const totalCount = useMemo(() => results.length, [results])

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!query.trim()) {
      setErrorMessage('검색어를 입력해주세요.')
      return
    }

    setErrorMessage(null)
    setIsLoading(true)

    const response = await searchDocuments(query.trim())

    if (!response.success) {
      setErrorMessage(response.error ?? '요청 처리 중 오류가 발생했습니다.')
      setIsLoading(false)
      return
    }

    setResults(response.data ?? [])
    setIsLoading(false)
  }

  return (
    <div className="page-shell">
      <main className="card">
        <header className="hero">
          <p className="eyebrow">Vector Search Playground</p>
          <h1>NamuWiki Vector Search Practice</h1>
          <p className="subtitle">
            pgvector 기반 검색 학습을 위한 실험 UI입니다. Stitch 산출물 인증 이후 동일 구조로 교체됩니다.
          </p>
        </header>

        <section className="search-panel">
          <form className="search-form" onSubmit={onSubmit}>
            <label htmlFor="query-input">질의어</label>
            <input
              id="query-input"
              name="query"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="예: 무궁화 꽃"
            />
            <button type="submit" disabled={isLoading}>
              {isLoading ? '검색 중...' : '검색'}
            </button>
          </form>

          {errorMessage ? <p className="error-banner">{errorMessage}</p> : null}
        </section>

        <section className="result-panel">
          <div className="result-header">
            <h2>검색 결과</h2>
            <span>{totalCount}건</span>
          </div>

          <ul>
            {results.map((item) => (
              <li key={item.id} className="result-row">
                <div>
                  <h3>{item.title}</h3>
                  <p>{item.snippet}</p>
                </div>
                <strong>{item.score.toFixed(3)}</strong>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  )
}
