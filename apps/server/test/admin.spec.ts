import { Test, TestingModule } from '@nestjs/testing'
import type { Request, Response } from 'express'
import { AdminController } from '../src/admin/admin.controller'
import { AdminService } from '../src/admin/admin.service'

const adminServiceMock = {
  listLanguages: jest.fn(),
  listManagedTables: jest.fn(),
  getBm25LanguageStatus: jest.fn(),
  registerExistingTable: jest.fn(),
  prepareTableBackfill: jest.fn(),
  getManagedTableBackfillStatus: jest.fn(),
  cancelTableBackfill: jest.fn(),
  updateBm25Settings: jest.fn(),
  createManagedDocument: jest.fn(),
  updateManagedDocument: jest.fn(),
  deleteManagedDocument: jest.fn(),
  runBm25Indexing: jest.fn(),
  runManagedTableBackfill: jest.fn()
}

async function createTestingModule(): Promise<TestingModule> {
  return Test.createTestingModule({
    controllers: [AdminController],
    providers: [
      {
        provide: AdminService,
        useValue: adminServiceMock
      }
    ]
  }).compile()
}

function createSseResponseMock(): Response & {
  body: string[]
  statusCode?: number
  jsonBody?: unknown
} {
  const body: string[] = []
  const response = {
    body,
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn((chunk: string) => {
      body.push(chunk)
      return true
    }),
    end: jest.fn(),
    status: jest.fn(function status(this: Response & { statusCode?: number }, code: number) {
      this.statusCode = code
      return this
    }),
    json: jest.fn(function json(this: Response & { jsonBody?: unknown }, payload: unknown) {
      this.jsonBody = payload
      return this
    })
  }

  return response as unknown as Response & {
    body: string[]
    statusCode?: number
    jsonBody?: unknown
  }
}

describe('AdminController', () => {
  beforeEach(() => {
    for (const fn of Object.values(adminServiceMock)) {
      fn.mockReset()
    }
  })

  it('returns supported languages payload', async () => {
    adminServiceMock.listLanguages.mockResolvedValueOnce([
      {
        language: 'korean',
        tableSuffix: 'korean',
        k1: 1.2,
        b: 0.75,
        lastIndexedAt: null,
        managedTableCount: 1,
        documentCount: 59008,
        tokenCount: 100,
        pendingTasks: 0,
        inProgressTasks: 0,
        completedTasks: 0
      }
    ])

    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AdminController)
    const response = await controller.listLanguages()

    expect(response.success).toBe(true)
    expect(response.data).toHaveLength(1)
    expect(response.data[0]).toEqual(
      expect.objectContaining({
        language: 'korean',
        managedTableCount: 1,
        documentCount: 59008
      })
    )
  })

  it('returns managed tables payload', async () => {
    adminServiceMock.listManagedTables.mockResolvedValueOnce([
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
        lastIndexedAt: null,
        embeddingCoverage: 1,
        ftsCoverage: 1,
        embeddingReady: true,
        ftsReady: true,
        bm25Ready: true,
        searchEligible: true,
        backfill: {
          tableName: 'namuwiki_documents',
          status: 'completed',
          totalRows: 59008,
          processedRows: 59008,
          remainingRows: 0,
          lastProcessedId: 59008,
          cancelRequested: false,
          lastStartedAt: '2026-03-08T00:00:00.000Z',
          lastCompletedAt: '2026-03-08T00:01:00.000Z',
          lastError: null
        }
      }
    ])

    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AdminController)
    const response = await controller.listManagedTables()

    expect(response.success).toBe(true)
    expect(response.data[0]).toEqual(
      expect.objectContaining({
        tableName: 'namuwiki_documents',
        isDefault: true
      })
    )
  })

  it('returns bm25 language status payload', async () => {
    adminServiceMock.getBm25LanguageStatus.mockResolvedValueOnce({
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
        uniqueTokens: 1000
      },
      managedTablesUsingLanguage: ['namuwiki_documents']
    })

    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AdminController)
    const response = await controller.getBm25LanguageStatus('korean')

    expect(response.success).toBe(true)
    expect(response.data[0]).toEqual(
      expect.objectContaining({
        language: 'korean',
        queue: expect.objectContaining({ pending: 0 })
      })
    )
    expect(adminServiceMock.getBm25LanguageStatus).toHaveBeenCalledWith('korean')
  })

  it('rejects register-existing request without tableName', async () => {
    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AdminController)
    const response = await controller.registerExistingTable({ language: 'korean' })

    expect(response.success).toBe(false)
    expect(response.error).toBe('tableName must be provided as string')
    expect(adminServiceMock.registerExistingTable).not.toHaveBeenCalled()
  })

  it('registers existing table with defaults', async () => {
    adminServiceMock.registerExistingTable.mockResolvedValueOnce({
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
        description: null,
        isDefault: false,
        isActive: true,
        rowCount: 59008,
        lastIndexedAt: null,
        embeddingCoverage: 0,
        ftsCoverage: 0,
        embeddingReady: false,
        ftsReady: false,
        bm25Ready: false,
        searchEligible: false,
        backfill: {
          tableName: 'namuwiki_documents',
          status: 'idle',
          totalRows: 59008,
          processedRows: 0,
          remainingRows: 59008,
          lastProcessedId: null,
          cancelRequested: false,
          lastStartedAt: null,
          lastCompletedAt: null,
          lastError: null
        }
      },
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
          uniqueTokens: 1000
        },
        managedTablesUsingLanguage: ['namuwiki_documents']
      }
    })

    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AdminController)
    const response = await controller.registerExistingTable({
      tableName: 'namuwiki_documents',
      language: 'korean',
      makeDefault: true
    })

    expect(response.success).toBe(true)
    expect(response.data).toHaveLength(1)
    expect(adminServiceMock.registerExistingTable).toHaveBeenCalledWith(
      expect.objectContaining({
        tableName: 'namuwiki_documents',
        language: 'korean',
        makeDefault: true
      })
    )
  })

  it('prepares and reads managed table backfill status', async () => {
    const status = {
      tableName: 'namuwiki_documents',
      status: 'idle',
      totalRows: 59008,
      processedRows: 0,
      remainingRows: 59008,
      lastProcessedId: null,
      cancelRequested: false,
      lastStartedAt: null,
      lastCompletedAt: null,
      lastError: null
    }
    adminServiceMock.prepareTableBackfill.mockResolvedValueOnce(status)
    adminServiceMock.getManagedTableBackfillStatus.mockResolvedValueOnce(status)

    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AdminController)

    const prepareResponse = await controller.prepareManagedTableBackfill('namuwiki_documents')
    const statusResponse = await controller.getManagedTableBackfillStatus('namuwiki_documents')

    expect(prepareResponse.success).toBe(true)
    expect(statusResponse.success).toBe(true)
    expect(adminServiceMock.prepareTableBackfill).toHaveBeenCalledWith('namuwiki_documents')
    expect(adminServiceMock.getManagedTableBackfillStatus).toHaveBeenCalledWith('namuwiki_documents')
  })

  it('cancels managed table backfill', async () => {
    const status = {
      tableName: 'namuwiki_documents',
      status: 'cancelled',
      totalRows: 59008,
      processedRows: 500,
      remainingRows: 58508,
      lastProcessedId: 500,
      cancelRequested: true,
      lastStartedAt: '2026-03-08T00:00:00.000Z',
      lastCompletedAt: null,
      lastError: null
    }
    adminServiceMock.cancelTableBackfill.mockResolvedValueOnce(status)

    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AdminController)
    const response = await controller.cancelManagedTableBackfill('namuwiki_documents')

    expect(response.success).toBe(true)
    expect(response.data[0]).toEqual(status)
    expect(adminServiceMock.cancelTableBackfill).toHaveBeenCalledWith('namuwiki_documents')
  })

  it('updates bm25 settings', async () => {
    adminServiceMock.updateBm25Settings.mockResolvedValueOnce({
      language: 'korean',
      tableSuffix: 'korean',
      k1: 1.5,
      b: 0.6,
      lastIndexedAt: null,
      queue: { pending: 0, inProgress: 0, completed: 0 },
      lengths: { managedTables: 1, totalDocuments: 0, totalLength: 0, averageLength: 0 },
      tokens: { uniqueTokens: 0 },
      managedTablesUsingLanguage: ['namuwiki_documents']
    })

    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AdminController)
    const response = await controller.updateBm25Settings('korean', { k1: 1.5, b: 0.6 })

    expect(response.success).toBe(true)
    expect(adminServiceMock.updateBm25Settings).toHaveBeenCalledWith('korean', {
      k1: 1.5,
      b: 0.6
    })
  })

  it('rejects empty bm25 settings updates', async () => {
    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AdminController)
    const response = await controller.updateBm25Settings('korean', {})

    expect(response.success).toBe(false)
    expect(response.error).toBe('At least one of k1 or b must be provided')
  })

  it('creates managed document', async () => {
    adminServiceMock.createManagedDocument.mockResolvedValueOnce({
      tableName: 'namuwiki_documents',
      language: 'korean',
      id: 77,
      taskQueued: true,
      taskType: 'insert'
    })

    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AdminController)
    const response = await controller.createManagedDocument('namuwiki_documents', {
      docHash: 'hash-1',
      title: '포켓몬',
      content: '피카츄',
      embedding: [0.1, 0.2]
    })

    expect(response.success).toBe(true)
    expect(adminServiceMock.createManagedDocument).toHaveBeenCalledWith(
      'namuwiki_documents',
      expect.objectContaining({
        docHash: 'hash-1',
        title: '포켓몬',
        content: '피카츄',
        embedding: [0.1, 0.2]
      })
    )
  })

  it('updates managed document', async () => {
    adminServiceMock.updateManagedDocument.mockResolvedValueOnce({
      tableName: 'namuwiki_documents',
      language: 'korean',
      id: 77,
      taskQueued: true,
      taskType: 'update'
    })

    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AdminController)
    const response = await controller.updateManagedDocument(
      'namuwiki_documents',
      '77',
      {
        content: '라이츄',
        embeddingHnsw: [0.1, 0.2]
      }
    )

    expect(response.success).toBe(true)
    expect(adminServiceMock.updateManagedDocument).toHaveBeenCalledWith(
      'namuwiki_documents',
      77,
      expect.objectContaining({
        content: '라이츄',
        embeddingHnsw: [0.1, 0.2]
      })
    )
  })

  it('deletes managed document', async () => {
    adminServiceMock.deleteManagedDocument.mockResolvedValueOnce({
      tableName: 'namuwiki_documents',
      language: 'korean',
      id: 77,
      taskQueued: true,
      taskType: 'delete'
    })

    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AdminController)
    const response = await controller.deleteManagedDocument('namuwiki_documents', '77')

    expect(response.success).toBe(true)
    expect(adminServiceMock.deleteManagedDocument).toHaveBeenCalledWith(
      'namuwiki_documents',
      77
    )
  })

  it('streams managed table backfill events over sse', async () => {
    adminServiceMock.runManagedTableBackfill.mockImplementationOnce(
      async (
        tableName: string,
        chunkSize: number,
        emit: (event: { event: string; tableName: string; chunkSize: number }) => void
      ) => {
        emit({ event: 'started', tableName, chunkSize })
        emit({ event: 'completed', tableName, chunkSize })
      }
    )

    const request = {
      on: jest.fn()
    } as unknown as Request
    const response = createSseResponseMock()

    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AdminController)
    await controller.runManagedTableBackfill('namuwiki_documents', '25', request, response)

    expect(response.body.join('')).toContain('event: started')
    expect(response.body.join('')).toContain('event: completed')
    expect(adminServiceMock.runManagedTableBackfill).toHaveBeenCalledWith(
      'namuwiki_documents',
      25,
      expect.any(Function),
      expect.any(Function)
    )
    expect(response.end).toHaveBeenCalled()
  })

  it('streams bm25 indexing events over sse', async () => {
    adminServiceMock.runBm25Indexing.mockImplementationOnce(
      async (
        language: string,
        chunkSize: number,
        emit: (event: { event: string; language: string; chunkSize: number }) => void
      ) => {
        emit({ event: 'started', language, chunkSize })
        emit({ event: 'completed', language, chunkSize })
      }
    )

    const request = {
      on: jest.fn()
    } as unknown as Request
    const response = createSseResponseMock()

    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AdminController)
    await controller.runBm25Indexing('korean', '25', request, response)

    expect(response.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'text/event-stream'
    )
    expect(response.body.join('')).toContain('event: started')
    expect(response.body.join('')).toContain('event: completed')
    expect(adminServiceMock.runBm25Indexing).toHaveBeenCalledWith(
      'korean',
      25,
      expect.any(Function),
      expect.any(Function)
    )
    expect(response.end).toHaveBeenCalled()
  })

  it('rejects invalid chunk size before starting sse', async () => {
    const request = {
      on: jest.fn()
    } as unknown as Request
    const response = createSseResponseMock()

    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AdminController)
    await controller.runBm25Indexing('korean', '0', request, response)

    expect(response.status).toHaveBeenCalledWith(400)
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: 'chunkSize must be a positive integer'
      })
    )
    expect(adminServiceMock.runBm25Indexing).not.toHaveBeenCalled()
  })
})
