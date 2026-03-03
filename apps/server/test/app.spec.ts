import { Test, TestingModule } from '@nestjs/testing'
import { AppController } from '../src/app.controller'
import { AppService } from '../src/app.service'
import { PrismaService } from '../src/prisma/prisma.service'

const prismaServiceMock = {
  $queryRawUnsafe: jest.fn()
}

async function createTestingModule(): Promise<TestingModule> {
  return Test.createTestingModule({
    controllers: [AppController],
    providers: [
      AppService,
      {
        provide: PrismaService,
        useValue: prismaServiceMock
      }
    ]
  }).compile()
}

describe('AppController', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('returns api health payload with db status', async () => {
    prismaServiceMock.$queryRawUnsafe.mockResolvedValueOnce([{ '?column?': 1 }])

    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AppController)
    const response = await controller.health()

    expect(response.success).toBe(true)
    expect(response.data).toHaveLength(1)
    expect(response.data[0]).toEqual({
      status: 'ok',
      service: 'vector-search-server',
      database: 'up'
    })
  })

  it('returns search envelope with items and learning fields', async () => {
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
    expect(response.meta).toEqual(
      expect.objectContaining({
        total: 1,
        offset: 0,
        limit: 10
      })
    )
  })

  it('returns validation error envelope for empty query', async () => {
    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AppController)
    const response = await controller.search({ query: '   ' })

    expect(response.success).toBe(false)
    expect(response.data).toEqual([])
    expect(response.error).toBe('query is required')
  })

  it('returns hybrid search envelope', async () => {
    prismaServiceMock.$queryRawUnsafe
      .mockResolvedValueOnce([
        {
          query_vector: '[0.1,0.2,0.3]'
        }
      ])
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
                'Node Type': 'Bitmap Heap Scan',
                'Relation Name': 'namuwiki_documents',
                'Total Cost': 24.5,
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

    expect(response.success).toBe(true)
    expect(response.data[0].items).toHaveLength(1)
    expect(response.data[0].learning.generatedSql).toContain('hybridRatio: 70')
    expect(response.data[0].learning.generatedSql).toContain("to_tsquery('korean'")
    expect(response.data[0].learning.generatedSql).toContain('LIMIT $8 OFFSET $9')
    expect(response.data[0].learning.generatedSql).toContain('ranking: vector+bm25-hybrid')
    expect(response.data[0].learning.keywordSignals?.[0]?.keyword).toBe('arm')
    expect(response.data[0].learning.pipelineTimings).toEqual(
      expect.objectContaining({
        normalizeAndAnalyzeMs: expect.any(Number),
        seedLookupMs: expect.any(Number),
        annQueryMs: expect.any(Number),
        resultAssembleMs: expect.any(Number),
        totalPipelineMs: expect.any(Number),
        seedLookupAttempts: expect.any(Number),
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

  it('prioritizes technical seed terms for mixed korean and english query intent', async () => {
    prismaServiceMock.$queryRawUnsafe
      .mockResolvedValueOnce([
        {
          query_vector: '[0.2,0.1,0.4]'
        }
      ])
      .mockResolvedValueOnce([
        {
          id: BigInt(2),
          title: 'CPU 벤치마크',
          snippet: '최신 CPU 성능 비교 ...',
          namespace: 'Hardware',
          contributors: 'user-c',
          vector_distance: 0.15
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
                'Total Cost': 21.9,
                'Plan Rows': 1
              }
            }
          ]
        }
      ])

    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AppController)
    const response = await controller.searchHybrid({
      query: '가장 좋은 CPU',
      offset: 0,
      limit: 10,
      mode: 'hnsw',
      bm25Enabled: true,
      hybridRatio: 50
    })

    expect(response.success).toBe(true)
    expect(response.data[0].items).toHaveLength(1)
    expect(response.data[0].items[0].title).toBe('CPU 벤치마크')
    expect(response.data[0].items[0].usedKeywords).toContain('cpu')
    expect(response.data[0].learning.keywordSignals?.[0]?.keyword).toBe('cpu')
    expect(response.data[0].learning.generatedSql).toContain('technicalSeedTsQuery: cpu')
  })

  it('falls back to LIKE seed when korean FTS and title seed are missing', async () => {
    prismaServiceMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ query_vector: null }])
      .mockResolvedValueOnce([{ query_vector: null }])
      .mockResolvedValueOnce([{ query_vector: '[0.2,0.1,0.3]' }])
      .mockResolvedValueOnce([
        {
          id: BigInt(7),
          title: '인사 안내',
          snippet: '인사 관련 안내 ...',
          namespace: 'Language',
          contributors: 'user-k',
          vector_distance: 0.11,
          bm25_score: 0.72,
          title_match_score: 1
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
      hybridRatio: 60
    })

    expect(response.success).toBe(true)
    expect(response.data[0].items).toHaveLength(1)
    expect(response.data[0].items[0].title).toBe('인사 안내')
    expect(response.data[0].learning.generatedSql).toContain("ORDER BY CASE")
    expect(response.data[0].learning.generatedSql).toContain("to_tsquery('korean'")
  })

  it('applies short-query strategy for ambiguous korean terms in hnsw mode', async () => {
    prismaServiceMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ query_vector: '[0.1,0.3,0.2]' }])
      .mockResolvedValueOnce([
        {
          id: BigInt(21),
          title: '인사청문회/조국',
          snippet: '인사청문회 ...',
          namespace: 'Politics',
          contributors: 'user-q',
          vector_distance: 0.42,
          bm25_score: 0.1667,
          title_match_score: 1
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
                'Total Cost': 31.7,
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
      hybridRatio: 50
    })

    expect(response.success).toBe(true)
    expect(response.data[0].items).toHaveLength(1)
    expect(response.data[0].items[0].title).toBe('인사청문회/조국')
    expect(response.data[0].learning.generatedSql).toContain('shortQueryStrategy: seed-priority')
  })

  it('keeps hybrid matchRate bounded when bm25 is disabled', async () => {
    prismaServiceMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ query_vector: '[0.1,0.2,0.3]' }])
      .mockResolvedValueOnce([
        {
          id: BigInt(12),
          title: '포켓몬',
          snippet: '포켓몬 문서 ...',
          namespace: 'Game',
          contributors: 'user-p',
          vector_distance: 0
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
    expect(response.data[0].items).toHaveLength(1)
    expect(response.data[0].items[0].matchRate).toBe(100)
    expect(response.data[0].items[0].score).toBe(1)
  })

  it('keeps lexical gate enabled for non-long intent query and preserves rank tsquery terms', async () => {
    prismaServiceMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ query_vector: '[0.3,0.1,0.2]' }])
      .mockResolvedValueOnce([
        {
          id: BigInt(44),
          title: '포켓몬 최강 랭킹',
          snippet: '가장 강한 포켓몬 ...',
          namespace: 'Game',
          contributors: 'user-p',
          vector_distance: 0.2,
          bm25_score: 0.8,
          title_match_score: 1,
          used_keywords: ['포켓몬', '가장', '강한'],
          matched_keywords: ['포켓몬', '강한']
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
                'Total Cost': 40.5,
                'Plan Rows': 10
              }
            }
          ]
        }
      ])

    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AppController)
    const response = await controller.searchHybrid({
      query: '가장 강한 포켓몬',
      offset: 0,
      limit: 10,
      mode: 'hnsw',
      bm25Enabled: true,
      hybridRatio: 53
    })

    expect(response.success).toBe(true)
    expect(response.data[0].items).toHaveLength(1)
    expect(response.data[0].items[0].title).toBe('포켓몬 최강 랭킹')
    expect(response.data[0].learning.generatedSql).toContain('ranking: vector+bm25-hybrid')
    expect(response.data[0].learning.generatedSql).toContain('rankTsQuery:')
    expect(response.data[0].learning.generatedSql).toContain('포켓몬')
    expect(response.data[0].learning.generatedSql).toContain('강한')
  })

  it('keeps lexical gate on for long query when domain anchor keyword exists', async () => {
    prismaServiceMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ query_vector: '[0.1,0.2,0.3]' }])
      .mockResolvedValueOnce([
        {
          id: BigInt(55),
          title: '포켓몬 대전 메타',
          snippet: '포켓몬 대전에서 강한 조합 ...',
          namespace: 'Game',
          contributors: 'user-r',
          vector_distance: 0.2,
          bm25_score: 0.9,
          title_match_score: 1,
          used_keywords: ['포켓몬', '대전', '강한'],
          matched_keywords: ['포켓몬', '대전']
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
                'Total Cost': 42.1,
                'Plan Rows': 10
              }
            }
          ]
        }
      ])

    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AppController)
    const response = await controller.searchHybrid({
      query: '대전 환경에서 가장 강한 포켓몬 조합과 카운터 전략을 자세히 알려줘',
      offset: 0,
      limit: 10,
      mode: 'hnsw',
      bm25Enabled: true,
      hybridRatio: 53
    })

    expect(response.success).toBe(true)
    expect(response.data[0].items).toHaveLength(1)
    expect(response.data[0].learning.generatedSql).toContain('domainAnchor: on')
    expect(response.data[0].learning.generatedSql).toContain('ranking: vector+bm25-hybrid')
  })

  it('normalizes Korean particles in long non-domain queries for keyword tracing', async () => {
    prismaServiceMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ query_vector: '[0.2,0.3,0.1]' }])
      .mockResolvedValueOnce([
        {
          id: BigInt(77),
          title: '무한도전을 빛낸 100개의 장면들',
          snippet: '무한도전에서 화제가 된 장면 ...',
          namespace: 'Entertainment',
          contributors: 'user-z',
          vector_distance: 0.18,
          bm25_score: 0.95,
          title_match_score: 1,
          matched_keywords: ['100명', '빛낸']
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
                'Total Cost': 53.2,
                'Plan Rows': 10
              }
            }
          ]
        }
      ])

    const moduleRef = await createTestingModule()
    const controller = moduleRef.get(AppController)
    const response = await controller.searchHybrid({
      query: '대한민국을 빛낸 100명의 위인들',
      offset: 0,
      limit: 10,
      mode: 'hnsw',
      bm25Enabled: true,
      hybridRatio: 53
    })

    expect(response.success).toBe(true)
    expect(response.data[0].items).toHaveLength(1)
    expect(response.data[0].items[0].usedKeywords).toContain('대한민국')
    expect(response.data[0].items[0].usedKeywords).not.toContain('대한민국을')
    expect(response.data[0].learning.generatedSql).toContain('domainAnchor: off')
    expect(response.data[0].learning.generatedSql).toContain('ranking: vector+bm25-hybrid')
  })
})
