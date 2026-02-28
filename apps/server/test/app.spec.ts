import { Test } from '@nestjs/testing'
import { AppController } from '../src/app.controller'
import { AppService } from '../src/app.service'
import { PrismaService } from '../src/prisma/prisma.service'

const prismaServiceMock = {
  $queryRawUnsafe: jest.fn()
}

describe('AppController', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('returns api health payload with db status', async () => {
    prismaServiceMock.$queryRawUnsafe.mockResolvedValueOnce([{ '?column?': 1 }])

    const moduleRef = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        {
          provide: PrismaService,
          useValue: prismaServiceMock
        }
      ]
    }).compile()

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

    const moduleRef = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        {
          provide: PrismaService,
          useValue: prismaServiceMock
        }
      ]
    }).compile()

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
    const moduleRef = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        {
          provide: PrismaService,
          useValue: prismaServiceMock
        }
      ]
    }).compile()

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
          id: BigInt(1),
          title: 'ARM (Architecture)',
          snippet: 'ARM architecture ...',
          namespace: 'Computing',
          contributors: 'user-a,user-b',
          vector_score: 0.95,
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

    const moduleRef = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        {
          provide: PrismaService,
          useValue: prismaServiceMock
        }
      ]
    }).compile()

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
    expect(response.meta).toEqual(
      expect.objectContaining({
        total: 1,
        offset: 0,
        limit: 10
      })
    )
  })
})
