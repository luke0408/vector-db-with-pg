import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App } from './App'
import {
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
  type ManagedTableBackfillStatus,
  type ManagedTableSummary,
} from './lib/search-api'

vi.mock('./lib/search-api', async () => {
  const actual = await vi.importActual<typeof import('./lib/search-api')>('./lib/search-api')

  return {
    ...actual,
    searchDocuments: vi.fn(),
    listAdminLanguages: vi.fn(),
    listManagedTables: vi.fn(),
    getBm25LanguageStatus: vi.fn(),
    getManagedTableBackfillStatus: vi.fn(),
    initializeManagedTableBackfill: vi.fn(),
    cancelManagedTableBackfill: vi.fn(),
    registerExistingTable: vi.fn(),
    updateBm25Settings: vi.fn(),
    runBm25IndexingStream: vi.fn(),
    runManagedTableBackfillStream: vi.fn(),
  }
})

const mockedSearchDocuments = vi.mocked(searchDocuments)
const mockedListAdminLanguages = vi.mocked(listAdminLanguages)
const mockedListManagedTables = vi.mocked(listManagedTables)
const mockedGetBm25LanguageStatus = vi.mocked(getBm25LanguageStatus)
const mockedGetManagedTableBackfillStatus = vi.mocked(getManagedTableBackfillStatus)
const mockedInitializeManagedTableBackfill = vi.mocked(initializeManagedTableBackfill)
const mockedCancelManagedTableBackfill = vi.mocked(cancelManagedTableBackfill)
const mockedRegisterExistingTable = vi.mocked(registerExistingTable)
const mockedUpdateBm25Settings = vi.mocked(updateBm25Settings)
const mockedRunBm25IndexingStream = vi.mocked(runBm25IndexingStream)
const mockedRunManagedTableBackfillStream = vi.mocked(runManagedTableBackfillStream)

function createBackfillStatus(
  overrides: Partial<ManagedTableBackfillStatus> = {}
): ManagedTableBackfillStatus {
  return {
    tableName: overrides.tableName ?? 'namuwiki_documents',
    status: overrides.status ?? 'idle',
    totalRows: overrides.totalRows ?? 59008,
    processedRows: overrides.processedRows ?? 0,
    remainingRows: overrides.remainingRows ?? 59008,
    lastProcessedId: overrides.lastProcessedId ?? null,
    cancelRequested: overrides.cancelRequested ?? false,
    lastStartedAt: overrides.lastStartedAt ?? null,
    lastCompletedAt: overrides.lastCompletedAt ?? null,
    lastError: overrides.lastError ?? null,
  }
}

function createManagedTable(
  overrides: Partial<ManagedTableSummary> = {}
): ManagedTableSummary {
  const tableName = overrides.tableName ?? 'namuwiki_documents'
  const backfill = overrides.backfill ?? createBackfillStatus({ tableName })

  return {
    tableName,
    language: overrides.language ?? 'korean',
    idColumn: overrides.idColumn ?? 'id',
    docHashColumn: overrides.docHashColumn ?? 'doc_hash',
    titleColumn: overrides.titleColumn ?? 'title',
    contentColumn: overrides.contentColumn ?? 'content',
    textlenColumn: overrides.textlenColumn ?? 'textlen',
    ftsColumn: overrides.ftsColumn ?? 'fts',
    embeddingColumn: overrides.embeddingColumn ?? 'embedding_qwen',
    embeddingHnswColumn: overrides.embeddingHnswColumn ?? 'embedding_hnsw',
    embeddingDim: overrides.embeddingDim ?? 1024,
    embeddingHnswDim: overrides.embeddingHnswDim ?? 1024,
    reductionMethod: overrides.reductionMethod ?? 'prefix_truncation',
    description: overrides.description ?? 'Phase 1 managed registration',
    isDefault: overrides.isDefault ?? false,
    isActive: overrides.isActive ?? true,
    rowCount: overrides.rowCount ?? 59008,
    lastIndexedAt: overrides.lastIndexedAt ?? null,
    embeddingCoverage: overrides.embeddingCoverage ?? 1,
    ftsCoverage: overrides.ftsCoverage ?? 1,
    embeddingReady: overrides.embeddingReady ?? true,
    ftsReady: overrides.ftsReady ?? true,
    bm25Ready: overrides.bm25Ready ?? true,
    searchEligible: overrides.searchEligible ?? true,
    backfill,
  }
}

function buildManagedTables(): ManagedTableSummary[] {
  return [
    createManagedTable({
      tableName: 'namuwiki_documents',
      isDefault: true,
      searchEligible: true,
      bm25Ready: true,
      embeddingCoverage: 1,
      ftsCoverage: 1,
      backfill: createBackfillStatus({
        tableName: 'namuwiki_documents',
        status: 'completed',
        totalRows: 59008,
        processedRows: 59008,
        remainingRows: 0,
        lastCompletedAt: '2026-03-08T00:00:00.000Z',
      }),
    }),
    createManagedTable({
      tableName: 'encyclopedia_documents',
      isDefault: false,
      searchEligible: true,
      bm25Ready: true,
      embeddingCoverage: 1,
      ftsCoverage: 1,
      rowCount: 1200,
      backfill: createBackfillStatus({
        tableName: 'encyclopedia_documents',
        status: 'idle',
        totalRows: 1200,
        processedRows: 300,
        remainingRows: 900,
      }),
    }),
    createManagedTable({
      tableName: 'legacy_documents',
      isDefault: false,
      searchEligible: false,
      bm25Ready: false,
      embeddingCoverage: 0.42,
      ftsCoverage: 0.73,
      embeddingReady: false,
      ftsReady: false,
      rowCount: 980,
      backfill: createBackfillStatus({
        tableName: 'legacy_documents',
        status: 'running',
        totalRows: 980,
        processedRows: 420,
        remainingRows: 560,
        lastStartedAt: '2026-03-08T00:00:00.000Z',
      }),
    }),
  ]
}

describe('App', () => {
  beforeEach(() => {
    const storage = new Map<string, string>()
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => storage.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage.set(key, value)
        }),
        removeItem: vi.fn((key: string) => {
          storage.delete(key)
        }),
        clear: vi.fn(() => {
          storage.clear()
        }),
      },
    })

    mockedSearchDocuments.mockResolvedValue({
      success: true,
      data: [
        {
          items: [],
          learning: {
            generatedSql: '-- test sql',
            executionPlan: {},
            queryExplanation: 'test explanation',
          },
        },
      ],
      meta: {
        total: 0,
        offset: 0,
        limit: 10,
        tookMs: 1,
      },
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
          managedTableCount: 3,
          documentCount: 61188,
          tokenCount: 1234,
          pendingTasks: 0,
          inProgressTasks: 0,
          completedTasks: 0,
        },
      ],
    })

    mockedListManagedTables.mockResolvedValue({
      success: true,
      data: buildManagedTables(),
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
            completed: 0,
          },
          lengths: {
            managedTables: 3,
            totalDocuments: 61188,
            totalLength: 123456,
            averageLength: 2.1,
          },
          tokens: {
            uniqueTokens: 1234,
          },
          managedTablesUsingLanguage: ['namuwiki_documents', 'encyclopedia_documents'],
        },
      ],
    })

    mockedGetManagedTableBackfillStatus.mockResolvedValue({
      success: true,
      data: [
        createBackfillStatus({
          tableName: 'namuwiki_documents',
          status: 'completed',
          totalRows: 59008,
          processedRows: 59008,
          remainingRows: 0,
          lastCompletedAt: '2026-03-08T00:00:00.000Z',
        }),
      ],
    })

    mockedInitializeManagedTableBackfill.mockResolvedValue({
      success: true,
      data: [
        createBackfillStatus({
          tableName: 'namuwiki_documents',
          status: 'idle',
          totalRows: 59008,
          processedRows: 0,
          remainingRows: 59008,
        }),
      ],
    })

    mockedCancelManagedTableBackfill.mockResolvedValue({
      success: true,
      data: [
        createBackfillStatus({
          tableName: 'namuwiki_documents',
          status: 'cancelled',
          totalRows: 59008,
          processedRows: 250,
          remainingRows: 58758,
          cancelRequested: true,
        }),
      ],
    })

    mockedRegisterExistingTable.mockResolvedValue({
      success: true,
      data: [
        {
          table: createManagedTable({
            tableName: 'namuwiki_documents',
            isDefault: true,
            searchEligible: true,
            bm25Ready: true,
            embeddingCoverage: 1,
            ftsCoverage: 1,
            backfill: createBackfillStatus({
              tableName: 'namuwiki_documents',
              status: 'completed',
              totalRows: 59008,
              processedRows: 59008,
              remainingRows: 0,
            }),
          }),
          bm25LanguageStatus: {
            language: 'korean',
            tableSuffix: 'korean',
            k1: 1.2,
            b: 0.75,
            lastIndexedAt: '2026-03-08T00:00:00.000Z',
            queue: {
              pending: 0,
              inProgress: 0,
              completed: 0,
            },
            lengths: {
              managedTables: 1,
              totalDocuments: 59008,
              totalLength: 123456,
              averageLength: 2.1,
            },
            tokens: {
              uniqueTokens: 1234,
            },
            managedTablesUsingLanguage: ['namuwiki_documents'],
          },
        },
      ],
    })

    mockedUpdateBm25Settings.mockResolvedValue({
      success: true,
      data: [
        {
          language: 'korean',
          tableSuffix: 'korean',
          k1: 1.5,
          b: 0.6,
          lastIndexedAt: null,
          queue: {
            pending: 0,
            inProgress: 0,
            completed: 0,
          },
          lengths: {
            managedTables: 3,
            totalDocuments: 61188,
            totalLength: 123456,
            averageLength: 2.1,
          },
          tokens: {
            uniqueTokens: 1234,
          },
          managedTablesUsingLanguage: ['namuwiki_documents', 'encyclopedia_documents'],
        },
      ],
    })

    mockedRunBm25IndexingStream.mockImplementation(async (_language, options) => {
      options.onEvent({
        event: 'started',
        language: 'korean',
        chunkSize: options.chunkSize,
        processedTasks: 0,
        remainingTasks: 2,
      })
      options.onEvent({
        event: 'completed',
        language: 'korean',
        chunkSize: options.chunkSize,
        processedTasks: 2,
        remainingTasks: 0,
      })
    })

    mockedRunManagedTableBackfillStream.mockImplementation(async (_tableName, options) => {
      options.onEvent({
        event: 'started',
        tableName: 'namuwiki_documents',
        chunkSize: options.chunkSize,
        processedRows: 0,
        remainingRows: 59008,
      })
      options.onEvent({
        event: 'chunk',
        tableName: 'namuwiki_documents',
        chunkSize: options.chunkSize,
        processedRows: 250,
        remainingRows: 58758,
        updatedRows: 250,
      })
      options.onEvent({
        event: 'completed',
        tableName: 'namuwiki_documents',
        chunkSize: options.chunkSize,
        processedRows: 59008,
        remainingRows: 0,
        updatedRows: 58758,
      })
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders stitch screen as native react layout', async () => {
    render(<App />)

    expect(screen.getByText('NamuWiki Vector Search Practice')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run Search' })).toBeInTheDocument()
    expect(screen.getByText('Generated SQL')).toBeInTheDocument()
    expect(screen.getByText('Query Execution Plan')).toBeInTheDocument()
    expect(screen.getByText('Query Explanation')).toBeInTheDocument()
    expect(screen.getByText('Run a search to view query explanation.')).toBeInTheDocument()

    const blockedOption = await screen.findByRole('option', {
      name: /legacy_documents .* blocked/i,
    })
    expect(blockedOption).toBeDisabled()
  })

  it('runs search when Enter is pressed in the query input', async () => {
    render(<App />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Run Search' })).toBeEnabled()
    })

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
        tableName: 'namuwiki_documents',
        mode: 'none',
        bm25Enabled: true,
        hybridRatio: 50,
        embeddingModel: 'qwen3',
      })
    )
  })

  it('sends selected eligible managed table when changed', async () => {
    render(<App />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Run Search' })).toBeEnabled()
    })

    const tableSelect = await screen.findByRole('combobox', { name: 'Managed Table' })
    fireEvent.change(tableSelect, { target: { value: 'encyclopedia_documents' } })

    const input = screen.getByPlaceholderText('Search across NamuWiki articles...')
    fireEvent.change(input, { target: { value: 'vector db' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', charCode: 13 })

    await waitFor(() => {
      expect(mockedSearchDocuments).toHaveBeenCalledTimes(1)
    })

    expect(mockedSearchDocuments).toHaveBeenCalledWith(
      'vector db',
      expect.objectContaining({
        tableName: 'encyclopedia_documents',
        embeddingModel: 'qwen3',
      })
    )
  })

  it('clearly blocks search when no table is eligible', async () => {
    mockedListManagedTables.mockResolvedValueOnce({
      success: true,
      data: [
        createManagedTable({
          tableName: 'legacy_documents',
          isDefault: true,
          searchEligible: false,
          bm25Ready: false,
          embeddingCoverage: 0.2,
          ftsCoverage: 0.4,
          embeddingReady: false,
          ftsReady: false,
          backfill: createBackfillStatus({
            tableName: 'legacy_documents',
            status: 'running',
            totalRows: 980,
            processedRows: 120,
            remainingRows: 860,
          }),
        }),
      ],
    })

    render(<App />)

    expect(
      await screen.findAllByText(/No search-eligible managed table is available yet\./i)
    ).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Run Search' })).toBeDisabled()
    expect(mockedSearchDocuments).not.toHaveBeenCalled()
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
              score: 0.95,
            },
          ],
          learning: {
            generatedSql: '-- test sql',
            executionPlan: {},
            queryExplanation: 'test explanation',
          },
        },
      ],
      meta: {
        total: 1,
        offset: 0,
        limit: 10,
        tookMs: 1,
      },
    })

    render(<App />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Run Search' })).toBeEnabled()
    })

    const input = screen.getByPlaceholderText('Search across NamuWiki articles...')
    fireEvent.change(input, { target: { value: 'bee swarm' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })

    await waitFor(() => {
      expect(
        screen.getByText(/Roblox의 Bee Swarm Simulator 의 몹에 관한 문서이다\./)
      ).toBeInTheDocument()
    })
  })

  it('loads admin overview and registers namuwiki table without initializeData', async () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'Admin' }))

    await waitFor(() => {
      expect(mockedListAdminLanguages).toHaveBeenCalledTimes(1)
      expect(mockedListManagedTables.mock.calls.length).toBeGreaterThanOrEqual(1)
    })

    await waitFor(() => {
      expect(mockedGetBm25LanguageStatus).toHaveBeenCalledWith('korean')
      expect(mockedGetManagedTableBackfillStatus).toHaveBeenCalledWith('namuwiki_documents')
    })

    expect(screen.getByText('Supported Languages')).toBeInTheDocument()
    expect(screen.getByText('Managed Table Readiness')).toBeInTheDocument()
    expect(screen.getByText('Embedding coverage')).toBeInTheDocument()
    expect(screen.getAllByText('namuwiki_documents').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: 'Register NamuWiki Table' }))

    await waitFor(() => {
      expect(mockedRegisterExistingTable).toHaveBeenCalledWith(
        expect.objectContaining({
          tableName: 'namuwiki_documents',
          language: 'korean',
          makeDefault: true,
        })
      )
    })

    expect(mockedRegisterExistingTable.mock.calls[0][0]).not.toHaveProperty('initializeData')
  })

  it('updates bm25 settings from the admin panel', async () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'Admin' }))

    await waitFor(() => {
      expect(mockedGetBm25LanguageStatus).toHaveBeenCalledWith('korean')
    })

    const k1Input = screen.getByLabelText('k1')
    const bInput = screen.getByLabelText('b')

    fireEvent.change(k1Input, { target: { value: '1.5' } })
    fireEvent.change(bInput, { target: { value: '0.6' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save BM25 Settings' }))

    await waitFor(() => {
      expect(mockedUpdateBm25Settings).toHaveBeenCalledWith('korean', {
        k1: 1.5,
        b: 0.6,
      })
    })
  })

  it('runs bm25 indexing and stores chunk size per language', async () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'Admin' }))

    await waitFor(() => {
      expect(mockedGetBm25LanguageStatus).toHaveBeenCalledWith('korean')
    })

    const chunkSizeInput = screen.getByLabelText('Chunk size')
    fireEvent.change(chunkSizeInput, { target: { value: '25' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run Indexing' }))

    await waitFor(() => {
      expect(mockedRunBm25IndexingStream).toHaveBeenCalledWith(
        'korean',
        expect.objectContaining({
          chunkSize: 25,
          onEvent: expect.any(Function),
          signal: expect.any(AbortSignal),
        })
      )
    })

    expect(window.localStorage.getItem('bm25-chunk-size:korean')).toBe('25')
    expect(screen.getByText(/processed=2/i)).toBeInTheDocument()
  })

  it('initializes and runs managed table backfill with progress log', async () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'Admin' }))

    await waitFor(() => {
      expect(mockedGetManagedTableBackfillStatus).toHaveBeenCalledWith('namuwiki_documents')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Prepare Backfill' }))

    await waitFor(() => {
      expect(mockedInitializeManagedTableBackfill).toHaveBeenCalledWith(
        'namuwiki_documents'
      )
    })

    const backfillChunkSizeInput = screen.getByLabelText('Backfill chunk size')
    fireEvent.change(backfillChunkSizeInput, { target: { value: '250' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run Backfill' }))

    await waitFor(() => {
      expect(mockedRunManagedTableBackfillStream).toHaveBeenCalledWith(
        'namuwiki_documents',
        expect.objectContaining({
          chunkSize: 250,
          onEvent: expect.any(Function),
          signal: expect.any(AbortSignal),
        })
      )
    })

    expect(window.localStorage.getItem('backfill-chunk-size:namuwiki_documents')).toBe('250')
    expect(screen.getByText(/updated=250/i)).toBeInTheDocument()
  })

  it('cancels managed table backfill from the admin panel', async () => {
    mockedRunManagedTableBackfillStream.mockImplementationOnce(async (_tableName, options) => {
      options.onEvent({
        event: 'started',
        tableName: 'namuwiki_documents',
        chunkSize: options.chunkSize,
        processedRows: 0,
        remainingRows: 59008,
      })

      await new Promise<void>((_, reject) => {
        options.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'))
        })
      })
    })

    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'Admin' }))

    await waitFor(() => {
      expect(mockedGetManagedTableBackfillStatus).toHaveBeenCalledWith('namuwiki_documents')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Run Backfill' }))

    await waitFor(() => {
      expect(mockedRunManagedTableBackfillStream).toHaveBeenCalledTimes(1)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Cancel Backfill' }))

    await waitFor(() => {
      expect(mockedCancelManagedTableBackfill).toHaveBeenCalledWith('namuwiki_documents')
    })

    expect(screen.getAllByText(/Cancelled from admin UI\./i).length).toBeGreaterThan(0)
  })
})
