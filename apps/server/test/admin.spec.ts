import { Test, TestingModule } from '@nestjs/testing'
import { AdminController } from '../src/admin/admin.controller'
import { AdminService } from '../src/admin/admin.service'

const adminServiceMock = {
  listLanguages: jest.fn(),
  listManagedTables: jest.fn(),
  getBm25LanguageStatus: jest.fn(),
  registerExistingTable: jest.fn()
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

describe('AdminController', () => {
  beforeEach(() => {
    adminServiceMock.listLanguages.mockReset()
    adminServiceMock.listManagedTables.mockReset()
    adminServiceMock.getBm25LanguageStatus.mockReset()
    adminServiceMock.registerExistingTable.mockReset()
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
        lastIndexedAt: null
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
      initializeData: true,
      makeDefault: true
    })

    expect(response.success).toBe(true)
    expect(response.data).toHaveLength(1)
    expect(adminServiceMock.registerExistingTable).toHaveBeenCalledWith(
      expect.objectContaining({
        tableName: 'namuwiki_documents',
        language: 'korean',
        initializeData: true,
        makeDefault: true
      })
    )
  })
})
