import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App } from './App'
import {
  getBm25LanguageStatus,
  listAdminLanguages,
  listManagedTables,
  registerExistingTable,
  searchDocuments
} from './lib/search-api'

vi.mock('./lib/search-api', async () => {
  const actual = await vi.importActual<typeof import('./lib/search-api')>('./lib/search-api')

  return {
    ...actual,
    searchDocuments: vi.fn(),
    listAdminLanguages: vi.fn(),
    listManagedTables: vi.fn(),
    getBm25LanguageStatus: vi.fn(),
    registerExistingTable: vi.fn()
  }
})

const mockedSearchDocuments = vi.mocked(searchDocuments)
const mockedListAdminLanguages = vi.mocked(listAdminLanguages)
const mockedListManagedTables = vi.mocked(listManagedTables)
const mockedGetBm25LanguageStatus = vi.mocked(getBm25LanguageStatus)
const mockedRegisterExistingTable = vi.mocked(registerExistingTable)

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

    mockedListAdminLanguages.mockResolvedValue({
      success: true,
      data: [
        {
          language: 'korean',
          tableSuffix: 'korean',
          k1: 1.2,
          b: 0.75,
          lastIndexedAt: null,
          managedTableCount: 1,
          documentCount: 59008,
          tokenCount: 1234,
          pendingTasks: 0,
          inProgressTasks: 0,
          completedTasks: 0
        }
      ]
    })

    mockedListManagedTables.mockResolvedValue({
      success: true,
      data: [
        {
          tableName: 'namuwiki_documents',
          language: 'korean',
          idColumn: 'id',
          docHashColumn: 'doc_hash',
          titleColumn: 'title',
          contentColumn: 'content',
          textlenColumn: 'textlen',
          ftsColumn: 'fts',
          embeddingColumn: 'embedding_qwen',
          embeddingHnswColumn: 'embedding_hnsw',
          embeddingDim: 1024,
          embeddingHnswDim: 1024,
          reductionMethod: 'prefix_truncation',
          description: 'Phase 1',
          isDefault: true,
          isActive: true,
          rowCount: 59008,
          lastIndexedAt: null
        }
      ]
    })

    mockedGetBm25LanguageStatus.mockResolvedValue({
      success: true,
      data: [
        {
          language: 'korean',
          tableSuffix: 'korean',
          k1: 1.2,
          b: 0.75,
          lastIndexedAt: null,
          queue: {
            pending: 0,
            inProgress: 0,
            completed: 0
          },
          lengths: {
            managedTables: 1,
            totalDocuments: 59008,
            totalLength: 123456,
            averageLength: 2.1
          },
          tokens: {
            uniqueTokens: 1234
          },
          managedTablesUsingLanguage: ['namuwiki_documents']
        }
      ]
    })

    mockedRegisterExistingTable.mockResolvedValue({
      success: true,
      data: [
        {
          table: {
            tableName: 'namuwiki_documents',
            language: 'korean',
            idColumn: 'id',
            docHashColumn: 'doc_hash',
            titleColumn: 'title',
            contentColumn: 'content',
            textlenColumn: 'textlen',
            ftsColumn: 'fts',
            embeddingColumn: 'embedding_qwen',
            embeddingHnswColumn: 'embedding_hnsw',
            embeddingDim: 1024,
            embeddingHnswDim: 1024,
            reductionMethod: 'prefix_truncation',
            description: 'Phase 1',
            isDefault: true,
            isActive: true,
            rowCount: 59008,
            lastIndexedAt: null
          },
          initializedData: true,
          bm25LanguageStatus: {
            language: 'korean',
            tableSuffix: 'korean',
            k1: 1.2,
            b: 0.75,
            lastIndexedAt: '2026-03-08T00:00:00.000Z',
            queue: {
              pending: 0,
              inProgress: 0,
              completed: 0
            },
            lengths: {
              managedTables: 1,
              totalDocuments: 59008,
              totalLength: 123456,
              averageLength: 2.1
            },
            tokens: {
              uniqueTokens: 1234
            },
            managedTablesUsingLanguage: ['namuwiki_documents']
          }
        }
      ]
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
        hybridRatio: 50,
        embeddingModel: 'base'
      })
    )
  })

  it('sends selected embedding model when toggled', async () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'QWEN3 (1024)' }))

    const input = screen.getByPlaceholderText('Search across NamuWiki articles...')
    fireEvent.change(input, { target: { value: 'vector db' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', charCode: 13 })

    await waitFor(() => {
      expect(mockedSearchDocuments).toHaveBeenCalledTimes(1)
    })

    expect(mockedSearchDocuments).toHaveBeenCalledWith(
      'vector db',
      expect.objectContaining({
        embeddingModel: 'qwen3'
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

  it('loads admin overview and registers namuwiki table', async () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'Admin' }))

    await waitFor(() => {
      expect(mockedListAdminLanguages).toHaveBeenCalledTimes(1)
      expect(mockedListManagedTables).toHaveBeenCalledTimes(1)
    })

    await waitFor(() => {
      expect(mockedGetBm25LanguageStatus).toHaveBeenCalledWith('korean')
    })

    expect(screen.getByText('Supported Languages')).toBeInTheDocument()
    expect(screen.getAllByText('namuwiki_documents').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: 'Register NamuWiki Table' }))

    await waitFor(() => {
      expect(mockedRegisterExistingTable).toHaveBeenCalledWith(
        expect.objectContaining({
          tableName: 'namuwiki_documents',
          language: 'korean',
          initializeData: true,
          makeDefault: true
        })
      )
    })
  })
})
