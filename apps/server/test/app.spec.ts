import { Test, TestingModule } from '@nestjs/testing'
import { AppController } from '../src/app.controller'
import { AppService } from '../src/app.service'
import { PrismaService } from '../src/prisma/prisma.service'
import { QueryEmbeddingService } from '../src/query-embedding.service'

const prismaServiceMock = {
  $queryRawUnsafe: jest.fn()
}

const queryEmbeddingServiceMock = {
  embedQuery: jest.fn(),
  getHealthStatus: jest.fn()
}

async function createTestingModule(): Promise<TestingModule> {
  return Test.createTestingModule({
    controllers: [AppController],
    providers: [
      AppService,
      {
        provide: PrismaService,
        useValue: prismaServiceMock
      },
      {
        provide: QueryEmbeddingService,
        useValue: queryEmbeddingServiceMock
      }
    ]
  }).compile()
}

describe('AppController', () => {
  beforeEach(() => {
    prismaServiceMock.$queryRawUnsafe.mockReset()
    queryEmbeddingServiceMock.embedQuery.mockReset()
    queryEmbeddingServiceMock.getHealthStatus.mockReset()
    queryEmbeddingServiceMock.embedQuery.mockResolvedValue({
      vectorLiteral: '[0.1,0.2,0.3]'
    })
    queryEmbeddingServiceMock.getHealthStatus.mockReturnValue({
      configuredModels: ['qwen3'],
      readyModels: ['qwen3'],
      pendingModels: [],
      ready: true
    })
    delete process.env.SEARCH_INCLUDE_EXPLAIN
    delete process.env.SEARCH_INCLUDE_TOTAL_COUNT
  })

  it('returns api health payload with db and prewarm status', async () => {
    prismaServiceMock.$queryRawUnsafe.mockResolvedValueOnce([{ '?column?': 1 }])

    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AppController)
    const response = await controller.health()

    expect(response.success).toBe(true)
    expect(response.data).toHaveLength(1)
    expect(response.data[0]).toEqual({
      status: 'ok',
      service: 'vector-search-server',
      database: 'up',
      prewarm: {
        ready: true,
        configuredModels: ['qwen3'],
        readyModels: ['qwen3'],
        pendingModels: []
      }
    })
  })

  it('reports warming state in health when prewarm is not ready yet', async () => {
    prismaServiceMock.$queryRawUnsafe.mockResolvedValueOnce([{ '?column?': 1 }])
    queryEmbeddingServiceMock.getHealthStatus.mockReturnValueOnce({
      configuredModels: ['qwen3'],
      readyModels: [],
      pendingModels: ['qwen3'],
      ready: false
    })

    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AppController)
    const response = await controller.health()

    expect(response.success).toBe(true)
    expect(response.error).toBeUndefined()
    expect(response.data[0]).toEqual(
      expect.objectContaining({
        status: 'ok',
        database: 'up',
        prewarm: expect.objectContaining({
          ready: false,
          pendingModels: ['qwen3']
        })
      })
    )
  })

  it('returns search envelope with execution plan by default', async () => {
    prismaServiceMock.$queryRawUnsafe
      .mockResolvedValueOnce([
        {
          id: BigInt(1),
          title: 'ARM (Architecture)',
          snippet:
            'ARM architecture is a family of reduced instruction set computer architectures for processors across mobile and server platforms.',
          namespace: 'Computing',
          contributors: 'user-a,user-b',
          score: 0.984
        }
      ])
      .mockResolvedValueOnce([{ total: BigInt(1) }])
      .mockResolvedValueOnce([
        {
          'QUERY PLAN': [
            {
              Plan: {
                'Node Type': 'Index Scan',
                'Relation Name': 'namuwiki_documents',
                'Total Cost': 12.34,
                'Plan Rows': 1
              }
            }
          ]
        }
      ])

    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AppController)
    const response = await controller.search({ query: 'ARM', offset: 0, limit: 10 })

    expect(response.success).toBe(true)
    expect(response.data).toHaveLength(1)
    expect(response.data[0].items).toHaveLength(1)
    expect(response.data[0].learning.generatedSql).toContain('SELECT')
    expect(response.data[0].learning.executionPlan['Node Type']).toBe('Index Scan')
    expect(response.meta?.embeddingModelUsed).toBe('base')
    expect(response.meta).toEqual(
      expect.objectContaining({
        total: 1,
        offset: 0,
        limit: 10
      })
    )
  })

  it('omits execution plan when explain mode is explicitly disabled', async () => {
    process.env.SEARCH_INCLUDE_EXPLAIN = 'false'
    prismaServiceMock.$queryRawUnsafe
      .mockResolvedValueOnce([
        {
          id: BigInt(1),
          title: 'ARM (Architecture)',
          snippet: 'ARM architecture ...',
          namespace: 'Computing',
          contributors: 'user-a,user-b',
          score: 0.984
        }
      ])
      .mockResolvedValueOnce([{ total: BigInt(1) }])

    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AppController)
    const response = await controller.search({ query: 'ARM', offset: 0, limit: 10 })

    expect(response.data[0].learning.executionPlan).toEqual({})
    expect(response.data[0].learning.queryExplanation).toContain('Execution plan omitted')
  })

  it('rejects invalid embedding model input for lexical search', async () => {
    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AppController)
    const response = await controller.search({ query: 'arm', embeddingModel: 'bad-model' })

    expect(response.success).toBe(false)
    expect(response.data).toEqual([])
    expect(response.error).toBe('embeddingModel must be one of base, qwen3')
  })

  it('returns validation error envelope for empty query', async () => {
    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AppController)
    const response = await controller.search({ query: '   ' })

    expect(response.success).toBe(false)
    expect(response.data).toEqual([])
    expect(response.error).toBe('query is required')
  })

  it('returns hybrid search envelope using runtime query embeddings with execution plan by default', async () => {
    prismaServiceMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ available: true }])
      .mockResolvedValueOnce([
        {
          id: BigInt(1),
          title: 'ARM (Architecture)',
          snippet: 'ARM architecture ...',
          namespace: 'Computing',
          contributors: 'user-a,user-b',
          vector_distance: 0.05,
          bm25_score: 0.55
        }
      ])
      .mockResolvedValueOnce([{ total: BigInt(1) }])
      .mockResolvedValueOnce([
        {
          'QUERY PLAN': [
            {
              Plan: {
                'Node Type': 'Limit',
                'Relation Name': 'namuwiki_document_embeddings_qwen',
                'Total Cost': 20,
                'Plan Rows': 1
              }
            }
          ]
        }
      ])

    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AppController)
    const response = await controller.searchHybrid({
      query: 'ARM',
      offset: 0,
      limit: 10,
      mode: 'hnsw',
      bm25Enabled: true,
      hybridRatio: 70
    })

    expect(queryEmbeddingServiceMock.embedQuery).toHaveBeenCalledWith('ARM', 'base')
    expect(response.success).toBe(true)
    expect(response.data[0].items).toHaveLength(1)
    expect(response.data[0].learning.generatedSql).toContain(
      'queryVectorSource: runtime-query-embedding'
    )
    expect(response.data[0].learning.generatedSql).toContain('hybridRatio: 70')
    expect(response.data[0].learning.generatedSql).toContain('candidatePool: 120')
    expect(response.data[0].learning.generatedSql).toContain('bm25QueryText: arm')
    expect(response.data[0].learning.generatedSql).toContain('bm25TsQueryMode: plainto_tsquery')
    expect(response.data[0].learning.generatedSql).toContain('ranking: vector+bm25-hybrid')
    expect(response.data[0].learning.executionPlan['Node Type']).toBe('Limit')
    expect(response.data[0].learning.keywordSignals?.[0]?.keyword).toBe('arm')
    expect(response.data[0].learning.pipelineTimings).toEqual(
      expect.objectContaining({
        normalizeAndAnalyzeMs: expect.any(Number),
        seedLookupMs: expect.any(Number),
        annQueryMs: expect.any(Number),
        resultAssembleMs: expect.any(Number),
        totalPipelineMs: expect.any(Number),
        seedLookupAttempts: 1,
        seedFound: true
      })
    )
    expect(response.data[0].items[0].usedKeywords).toContain('arm')
    expect(response.meta).toEqual(
      expect.objectContaining({
        total: 1,
        offset: 0,
        limit: 10
      })
    )
  })

  it('omits hybrid execution plan when explain mode is explicitly disabled', async () => {
    process.env.SEARCH_INCLUDE_EXPLAIN = 'false'
    prismaServiceMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ available: true }])
      .mockResolvedValueOnce([
        {
          id: BigInt(1),
          title: 'ARM (Architecture)',
          snippet: 'ARM architecture ...',
          namespace: 'Computing',
          contributors: 'user-a,user-b',
          vector_distance: 0.05,
          bm25_score: 0.55
        }
      ])
      .mockResolvedValueOnce([{ total: BigInt(1) }])

    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AppController)
    const response = await controller.searchHybrid({
      query: 'ARM',
      offset: 0,
      limit: 10,
      mode: 'hnsw',
      bm25Enabled: true,
      hybridRatio: 70
    })

    expect(response.success).toBe(true)
    expect(response.data[0].learning.executionPlan).toEqual({})
    expect(response.data[0].learning.queryExplanation).toContain('Execution plan omitted')
  })

  it('falls back to lexical BM25 when query embedding is unavailable', async () => {
    queryEmbeddingServiceMock.embedQuery.mockResolvedValueOnce({
      reason: 'query-embedding-unavailable'
    })
    prismaServiceMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ available: true }])
      .mockResolvedValueOnce([
        {
          id: BigInt(2),
          title: '김승민(래퍼)',
          snippet: '김승민은 대한민국의 래퍼다 ...',
          namespace: 'Music',
          contributors: 'user-c',
          bm25_score: 1.8,
          title_match: true,
          like_title_match: true,
          like_content_match: true
        }
      ])
      .mockResolvedValueOnce([{ total: BigInt(1) }])
      .mockResolvedValueOnce([
        {
          'QUERY PLAN': [
            {
              Plan: {
                'Node Type': 'Bitmap Heap Scan',
                'Relation Name': 'namuwiki_documents',
                'Total Cost': 18.2,
                'Plan Rows': 1
              }
            }
          ]
        }
      ])

    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AppController)
    const response = await controller.searchHybrid({
      query: '김승민(래퍼) 관점에서 핵심 개념과 배경을 알려줘',
      offset: 0,
      limit: 10,
      mode: 'hnsw',
      bm25Enabled: true,
      hybridRatio: 53
    })

    expect(response.success).toBe(true)
    expect(response.data[0].items[0].title).toBe('김승민(래퍼)')
    expect(response.data[0].items[0].usedKeywords).toContain('김승민')
    expect(response.data[0].items[0].usedKeywords).toContain('래퍼')
    expect(response.data[0].items[0].usedKeywords).not.toContain('김승민래퍼')
    expect(response.data[0].learning.generatedSql).toContain('fallbackStrategy: bm25-only')
    expect(response.data[0].learning.generatedSql).toContain('bm25QueryText:')
    expect(response.data[0].learning.generatedSql).toContain('김승민')
    expect(response.data[0].learning.generatedSql).toContain('래퍼')
    expect(response.data[0].learning.generatedSql).toContain(
      'fallbackReason: query-embedding-unavailable'
    )
    expect(response.data[0].learning.queryExplanation).toContain('Fell back to BM25 search')
    expect(response.data[0].learning.pipelineTimings?.seedFound).toBe(false)
  })

  it('falls back to lexical BM25 when the selected embedding store is empty', async () => {
    prismaServiceMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ available: false }])
      .mockResolvedValueOnce([
        {
          id: BigInt(7),
          title: '인사 안내',
          snippet: '인사 관련 안내 ...',
          namespace: 'Language',
          contributors: 'user-k',
          bm25_score: 0.72,
          title_match: true,
          like_title_match: true,
          like_content_match: true
        }
      ])
      .mockResolvedValueOnce([{ total: BigInt(1) }])
      .mockResolvedValueOnce([
        {
          'QUERY PLAN': [
            {
              Plan: {
                'Node Type': 'Index Scan',
                'Relation Name': 'namuwiki_documents',
                'Total Cost': 33.3,
                'Plan Rows': 1
              }
            }
          ]
        }
      ])

    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AppController)
    const response = await controller.searchHybrid({
      query: '인사',
      offset: 0,
      limit: 10,
      mode: 'ivf',
      bm25Enabled: true,
      hybridRatio: 60,
      embeddingModel: 'base'
    })

    expect(queryEmbeddingServiceMock.embedQuery).not.toHaveBeenCalled()
    expect(response.success).toBe(true)
    expect(response.data[0].items[0].title).toBe('인사 안내')
    expect(response.data[0].learning.generatedSql).toContain('fallbackStrategy: bm25-only')
    expect(response.data[0].learning.generatedSql).toContain(
      'fallbackReason: embedding-store-empty:base'
    )
  })

  it('falls back to lexical BM25 when ANN returns no candidates', async () => {
    prismaServiceMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ available: true }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: BigInt(0) }])
      .mockResolvedValueOnce([
        {
          'QUERY PLAN': [
            {
              Plan: {
                'Node Type': 'Limit',
                'Relation Name': 'namuwiki_document_embeddings_qwen',
                'Total Cost': 20,
                'Plan Rows': 0
              }
            }
          ]
        }
      ])
      .mockResolvedValueOnce([
        {
          id: BigInt(31),
          title: '인사청문회',
          snippet: '인사청문회 관련 설명 ...',
          namespace: 'Politics',
          contributors: 'user-x',
          bm25_score: 0.8,
          title_match: true,
          like_title_match: true,
          like_content_match: true
        }
      ])
      .mockResolvedValueOnce([{ total: BigInt(1) }])
      .mockResolvedValueOnce([
        {
          'QUERY PLAN': [
            {
              Plan: {
                'Node Type': 'Bitmap Heap Scan',
                'Relation Name': 'namuwiki_documents',
                'Total Cost': 18,
                'Plan Rows': 1
              }
            }
          ]
        }
      ])

    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AppController)
    const response = await controller.searchHybrid({
      query: '인사',
      offset: 0,
      limit: 10,
      mode: 'hnsw',
      bm25Enabled: true,
      hybridRatio: 53,
      embeddingModel: 'qwen3'
    })

    expect(response.success).toBe(true)
    expect(response.data[0].items[0].title).toBe('인사청문회')
    expect(response.data[0].learning.generatedSql).toContain('fallbackStrategy: bm25-only')
    expect(response.data[0].learning.generatedSql).toContain(
      'fallbackReason: ann-candidates-empty'
    )
  })

  it('falls back to lexical BM25 when ANN signal is weak for long natural language queries', async () => {
    prismaServiceMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ available: true }])
      .mockResolvedValueOnce([
        {
          id: BigInt(41),
          title: '엉뚱한 결과',
          snippet: '연관성이 낮은 문서 ...',
          namespace: 'Etc',
          contributors: 'user-y',
          vector_distance: 1.8,
          bm25_score: 0
        }
      ])
      .mockResolvedValueOnce([{ total: BigInt(1) }])
      .mockResolvedValueOnce([
        {
          'QUERY PLAN': [
            {
              Plan: {
                'Node Type': 'Limit',
                'Relation Name': 'namuwiki_document_embeddings_qwen',
                'Total Cost': 20,
                'Plan Rows': 1
              }
            }
          ]
        }
      ])
      .mockResolvedValueOnce([
        {
          id: BigInt(42),
          title: '포켓몬스터/배틀',
          snippet: '강한 포켓몬 설명 ...',
          namespace: 'Game',
          contributors: 'user-z',
          bm25_score: 1.4,
          title_match: true,
          like_title_match: true,
          like_content_match: true
        }
      ])
      .mockResolvedValueOnce([{ total: BigInt(1) }])
      .mockResolvedValueOnce([
        {
          'QUERY PLAN': [
            {
              Plan: {
                'Node Type': 'Bitmap Heap Scan',
                'Relation Name': 'namuwiki_documents',
                'Total Cost': 18,
                'Plan Rows': 1
              }
            }
          ]
        }
      ])

    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AppController)
    const response = await controller.searchHybrid({
      query: '포켓몬스터에서 가장 강한 포켓몬',
      offset: 0,
      limit: 10,
      mode: 'hnsw',
      bm25Enabled: true,
      hybridRatio: 53,
      embeddingModel: 'qwen3'
    })

    expect(response.success).toBe(true)
    expect(response.data[0].items[0].title).toBe('포켓몬스터/배틀')
    expect(response.data[0].learning.generatedSql).toContain('fallbackReason: ann-signal-weak')
    expect(response.data[0].learning.generatedSql).toContain('bm25QueryText:')
    expect(response.data[0].learning.generatedSql).toContain('포켓몬스터')
    expect(response.data[0].learning.generatedSql).toContain('포켓몬')
  })

  it('falls back to lexical LIKE search when bm25 is disabled and query embeddings are unavailable', async () => {
    queryEmbeddingServiceMock.embedQuery.mockResolvedValueOnce({
      reason: 'query-embedding-timeout'
    })
    prismaServiceMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ available: true }])
      .mockResolvedValueOnce([
        {
          id: BigInt(12),
          title: '포켓몬',
          snippet: '포켓몬 문서 ...',
          namespace: 'Game',
          contributors: 'user-p',
          score: 0.984
        }
      ])
      .mockResolvedValueOnce([{ total: BigInt(1) }])
      .mockResolvedValueOnce([
        {
          'QUERY PLAN': [
            {
              Plan: {
                'Node Type': 'Sort',
                'Relation Name': 'namuwiki_documents',
                'Total Cost': 99.9,
                'Plan Rows': 1
              }
            }
          ]
        }
      ])

    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AppController)
    const response = await controller.searchHybrid({
      query: '포켓몬',
      offset: 0,
      limit: 10,
      mode: 'hnsw',
      bm25Enabled: false,
      hybridRatio: 49
    })

    expect(response.success).toBe(true)
    expect(response.data[0].items[0].title).toBe('포켓몬')
    expect(response.data[0].learning.generatedSql).toContain('fallback: lexical-like')
    expect(response.data[0].learning.generatedSql).toContain(
      'reason: query-embedding-timeout'
    )
  })

  it('returns selected embedding model in meta for hybrid search', async () => {
    prismaServiceMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ available: true }])
      .mockResolvedValueOnce([
        {
          id: BigInt(88),
          title: 'QWEN 테스트',
          snippet: 'qwen embedding test ...',
          namespace: 'Test',
          contributors: 'user-t',
          vector_distance: 0.2,
          bm25_score: 0.7
        }
      ])
      .mockResolvedValueOnce([{ total: BigInt(1) }])
      .mockResolvedValueOnce([
        {
          'QUERY PLAN': [
            {
              Plan: {
                'Node Type': 'Limit',
                'Relation Name': 'namuwiki_documents',
                'Total Cost': 10,
                'Plan Rows': 1
              }
            }
          ]
        }
      ])

    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AppController)
    const response = await controller.searchHybrid({
      query: 'qwen',
      offset: 0,
      limit: 10,
      mode: 'hnsw',
      bm25Enabled: true,
      hybridRatio: 50,
      embeddingModel: 'qwen3'
    })

    expect(response.success).toBe(true)
    expect(response.meta?.embeddingModelUsed).toBe('qwen3')
    expect(response.data[0].learning.generatedSql).toContain('embeddingModel: qwen3')
  })

  it('rejects invalid embedding model input', async () => {
    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AppController)
    const response = await controller.searchHybrid({
      query: 'arm',
      embeddingModel: 'bad-model'
    })

    expect(response.success).toBe(false)
    expect(response.error).toBe('embeddingModel must be one of base, qwen3')
  })
})
