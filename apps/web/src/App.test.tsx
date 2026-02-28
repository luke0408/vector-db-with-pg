import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App } from './App'
import { searchDocuments } from './lib/search-api'

vi.mock('./lib/search-api', async () => {
  const actual = await vi.importActual<typeof import('./lib/search-api')>('./lib/search-api')

  return {
    ...actual,
    searchDocuments: vi.fn()
  }
})

const mockedSearchDocuments = vi.mocked(searchDocuments)

describe('App', () => {
  beforeEach(() => {
    mockedSearchDocuments.mockResolvedValue({
      success: true,
      data: [
        {
          items: [],
          learning: {
            generatedSql: '-- test sql',
            executionPlan: {},
            queryExplanation: 'test explanation'
          }
        }
      ],
      meta: {
        total: 0,
        offset: 0,
        limit: 10,
        tookMs: 1
      }
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders stitch screen as native react layout', () => {
    render(<App />)

    expect(screen.getByText('NamuWiki Vector Search Practice')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Search' })).toBeInTheDocument()
    expect(screen.getByText('Generated SQL')).toBeInTheDocument()
    expect(screen.getByText('Query Execution Plan')).toBeInTheDocument()
    expect(screen.getByText('Query Explanation')).toBeInTheDocument()
    expect(screen.getByText('Run a search to view query explanation.')).toBeInTheDocument()
  })

  it('runs search when Enter is pressed in the query input', async () => {
    render(<App />)

    const input = screen.getByPlaceholderText('Search across NamuWiki articles...')
    fireEvent.change(input, { target: { value: 'vector db' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', charCode: 13 })

    await waitFor(() => {
      expect(mockedSearchDocuments).toHaveBeenCalledTimes(1)
    })

    expect(mockedSearchDocuments).toHaveBeenCalledWith(
      'vector db',
      expect.objectContaining({
        offset: 0,
        limit: 10,
        mode: 'none',
        bm25Enabled: true,
        hybridRatio: 50
      })
    )
  })

  it('renders cleaned snippet text for wiki-style markup', async () => {
    mockedSearchDocuments.mockResolvedValueOnce({
      success: true,
      data: [
        {
          items: [
            {
              id: 1,
              title: 'Ant Challenge',
              snippet:
                '[[분류:나무위키 Roblox 프로젝트]][[분류:Bee Swarm Simulator]] [include(틀:상위 문서, top1=Bee Swarm Simulator)] [목차] == 개요 == [[Roblox]]의 [[Bee Swarm Simulator]] 의 몹에 관한 문서이다.',
              score: 0.95
            }
          ],
          learning: {
            generatedSql: '-- test sql',
            executionPlan: {},
            queryExplanation: 'test explanation'
          }
        }
      ],
      meta: {
        total: 1,
        offset: 0,
        limit: 10,
        tookMs: 1
      }
    })

    render(<App />)

    const input = screen.getByPlaceholderText('Search across NamuWiki articles...')
    fireEvent.change(input, { target: { value: 'bee swarm' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })

    await waitFor(() => {
      expect(
        screen.getByText(/Roblox의 Bee Swarm Simulator 의 몹에 관한 문서이다\./)
      ).toBeInTheDocument()
    })
  })
})
