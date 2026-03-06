import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'

jest.mock('node:child_process', () => ({
  spawn: jest.fn()
}))

jest.mock('node:fs', () => ({
  existsSync: jest.fn()
}))

const { QueryEmbeddingService } = require('../src/query-embedding.service') as typeof import('../src/query-embedding.service')

class MockReadable extends EventEmitter {
  setEncoding = jest.fn()
}

class MockChildProcess extends EventEmitter {
  stdout = new MockReadable()
  stderr = new MockReadable()
  stdin = {
    writable: true,
    write: jest.fn()
  }
  kill = jest.fn(() => true)
  killed = false
}

function emitReady(child: MockChildProcess, model: 'base' | 'qwen3' = 'qwen3'): void {
  child.stdout.emit('data', `${JSON.stringify({ event: 'ready', model })}\n`)
}

describe('QueryEmbeddingService', () => {
  const mockedSpawn = jest.mocked(spawn)
  const mockedExistsSync = jest.mocked(existsSync)

  beforeEach(() => {
    mockedSpawn.mockReset()
    mockedExistsSync.mockReset()
    mockedExistsSync.mockReturnValue(true)
  })

  it('reuses a spawned worker for the same embedding model', async () => {
    const child = new MockChildProcess()
    mockedSpawn.mockReturnValue(child as unknown as ChildProcessWithoutNullStreams)

    const service = new QueryEmbeddingService()
    const workerPromise = (service as any).getOrCreateWorker('qwen3')
    emitReady(child)
    const firstWorker = await workerPromise
    const secondWorker = await (service as any).getOrCreateWorker('qwen3')

    expect(firstWorker).toBe(secondWorker)
    expect(mockedSpawn).toHaveBeenCalledTimes(1)
  })

  it('caches query vectors and skips repeated worker requests for the same query', async () => {
    const service = new QueryEmbeddingService()
    const getOrCreateWorkerSpy = jest
      .spyOn(service as any, 'getOrCreateWorker')
      .mockResolvedValue({ model: 'qwen3' } as never)
    const requestEmbeddingSpy = jest
      .spyOn(service as any, 'requestEmbedding')
      .mockResolvedValue({ vectorLiteral: '[0.1,0.2,0.3]' })

    await expect(service.embedQuery('반복 질의', 'qwen3')).resolves.toEqual({
      vectorLiteral: '[0.1,0.2,0.3]'
    })
    await expect(service.embedQuery('반복 질의', 'qwen3')).resolves.toEqual({
      vectorLiteral: '[0.1,0.2,0.3]'
    })

    expect(getOrCreateWorkerSpy).toHaveBeenCalledTimes(1)
    expect(requestEmbeddingSpy).toHaveBeenCalledTimes(1)
  })

  it('kills active workers on module destroy', async () => {
    const service = new QueryEmbeddingService()
    const child = new MockChildProcess()

    ;(service as any).workers.set('qwen3', {
      child,
      model: 'qwen3',
      pending: new Map(),
      stdoutBuffer: '',
      ready: true,
      stderrBuffer: ''
    })

    await service.onModuleDestroy()

    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('can prewarm configured embedding workers on module init', async () => {
    const previous = process.env.QUERY_EMBED_PREWARM_MODELS
    process.env.QUERY_EMBED_PREWARM_MODELS = 'qwen3'
    const child = new MockChildProcess()
    mockedSpawn.mockReturnValue(child as unknown as ChildProcessWithoutNullStreams)

    try {
      const service = new QueryEmbeddingService()
      const initPromise = service.onModuleInit()
      emitReady(child)
      await initPromise

      expect(mockedSpawn).toHaveBeenCalledTimes(1)
      expect(service.getHealthStatus()).toEqual({
        configuredModels: ['qwen3'],
        readyModels: ['qwen3'],
        pendingModels: [],
        ready: true
      })
    } finally {
      process.env.QUERY_EMBED_PREWARM_MODELS = previous
    }
  })
})
