export interface SearchResult {
  id: number
  title: string
  snippet: string
  score: number
}

export interface SearchResponse {
  success: boolean
  data?: SearchResult[]
  error?: string
}

const SERVER_BASE_URL = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:3000'

export async function searchDocuments(query: string): Promise<SearchResponse> {
  const payload = { query }

  try {
    const response = await fetch(`${SERVER_BASE_URL}/api/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    })

    if (!response.ok) {
      return {
        success: false,
        error: `Request failed with status ${response.status}`
      }
    }

    const parsed = (await response.json()) as SearchResponse
    return parsed
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'

    return {
      success: false,
      error: `Search request failed: ${message}`
    }
  }
}
