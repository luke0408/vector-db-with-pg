import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio
} from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { EmbeddingModel } from './types/search-contract'

export interface QueryEmbeddingAttempt {
  vectorLiteral?: string
  reason?: string
}

export interface QueryEmbeddingHealthStatus {
  configuredModels: EmbeddingModel[]
  readyModels: EmbeddingModel[]
  pendingModels: EmbeddingModel[]
  ready: boolean
}

interface PendingWorkerRequest {
  reject: (reason?: unknown) => void
  resolve: (value: QueryEmbeddingAttempt) => void
  timeoutHandle: NodeJS.Timeout
}

interface QueryEmbeddingWorker {
  child: ChildProcessWithoutNullStreams
  model: EmbeddingModel
  pending: Map<number, PendingWorkerRequest>
  stdoutBuffer: string
  ready: boolean
  stderrBuffer: string
}

@Injectable()
export class QueryEmbeddingService implements OnModuleDestroy, OnModuleInit {
  private readonly cache = new Map<string, string>()
  private readonly workers = new Map<EmbeddingModel, QueryEmbeddingWorker>()
  private readonly workerPromises = new Map<EmbeddingModel, Promise<QueryEmbeddingWorker>>()
  private nextRequestId = 1

  async embedQuery(
    query: string,
    embeddingModel: EmbeddingModel
  ): Promise<QueryEmbeddingAttempt> {
    const normalizedQuery = query.trim()

    if (!normalizedQuery) {
      return {
        reason: 'empty-query'
      }
    }

    const cacheKey = `${embeddingModel}:${normalizedQuery}`
    const cachedVector = this.cache.get(cacheKey)

    if (cachedVector) {
      return {
        vectorLiteral: cachedVector
      }
    }

    const helperScriptPath = this.resolveHelperScriptPath()

    if (!existsSync(helperScriptPath)) {
      return {
        reason: `query-embedding-helper-missing:${helperScriptPath}`
      }
    }

    try {
      const worker = await this.getOrCreateWorker(embeddingModel)
      const result = await this.requestEmbedding(worker, normalizedQuery)

      if (!result.vectorLiteral) {
        return {
          reason: result.reason ?? 'query-embedding-vector-missing'
        }
      }

      this.cache.set(cacheKey, result.vectorLiteral)

      if (this.cache.size > 100) {
        const oldestCacheKey = this.cache.keys().next().value as string | undefined

        if (oldestCacheKey) {
          this.cache.delete(oldestCacheKey)
        }
      }

      return {
        vectorLiteral: result.vectorLiteral
      }
    } catch (error) {
      return {
        reason: this.describeError(error)
      }
    }
  }

  async onModuleInit(): Promise<void> {
    const prewarmModels = this.resolvePrewarmModels()

    if (prewarmModels.length === 0) {
      return
    }

    await Promise.all(prewarmModels.map((embeddingModel) => this.getOrCreateWorker(embeddingModel)))
  }

  async onModuleDestroy(): Promise<void> {
    for (const worker of this.workers.values()) {
      worker.child.kill()
    }

    this.workers.clear()
    this.workerPromises.clear()
  }

  getHealthStatus(): QueryEmbeddingHealthStatus {
    const configuredModels = this.resolvePrewarmModels()
    const readyModels = configuredModels.filter((embeddingModel) => {
      const worker = this.workers.get(embeddingModel)
      return worker?.ready === true && worker.child.killed === false
    })
    const pendingModels = configuredModels.filter(
      (embeddingModel) => readyModels.includes(embeddingModel) === false
    )

    return {
      configuredModels,
      readyModels,
      pendingModels,
      ready: pendingModels.length === 0
    }
  }

  private async getOrCreateWorker(
    embeddingModel: EmbeddingModel
  ): Promise<QueryEmbeddingWorker> {
    const existingWorker = this.workers.get(embeddingModel)

    if (existingWorker && !existingWorker.child.killed) {
      return existingWorker
    }

    const existingPromise = this.workerPromises.get(embeddingModel)

    if (existingPromise) {
      return existingPromise
    }

    const workerPromise = this.spawnWorker(embeddingModel)
    this.workerPromises.set(embeddingModel, workerPromise)

    try {
      const worker = await workerPromise
      this.workers.set(embeddingModel, worker)
      return worker
    } finally {
      this.workerPromises.delete(embeddingModel)
    }
  }

  private async spawnWorker(
    embeddingModel: EmbeddingModel
  ): Promise<QueryEmbeddingWorker> {
    const helperScriptPath = this.resolveHelperScriptPath()
    const spawnOptions: SpawnOptionsWithoutStdio = {
      cwd: this.resolveProjectRoot(),
      env: {
        ...process.env,
        HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE ?? '1',
        TRANSFORMERS_OFFLINE: process.env.TRANSFORMERS_OFFLINE ?? '1'
      },
      stdio: 'pipe'
    }
    const child = spawn(this.resolvePythonBin(), ['-W', 'ignore', helperScriptPath, '--serve', '--model', embeddingModel], spawnOptions)

    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')

    const worker: QueryEmbeddingWorker = {
      child,
      model: embeddingModel,
      pending: new Map<number, PendingWorkerRequest>(),
      stdoutBuffer: '',
      ready: false,
      stderrBuffer: ''
    }

    const readyTimeoutMs = this.resolveTimeoutMs(embeddingModel)

    return await new Promise<QueryEmbeddingWorker>((resolve, reject) => {
      const readyTimeoutHandle = setTimeout(() => {
        child.kill()
        reject(
          new Error(
            `query-embedding-worker-ready-timeout:model=${embeddingModel}:timeoutMs=${readyTimeoutMs}`
          )
        )
      }, readyTimeoutMs)

      const settleReady = (error?: Error): void => {
        clearTimeout(readyTimeoutHandle)

        if (error) {
          reject(error)
          return
        }

        resolve(worker)
      }

      child.stdout.on('data', (chunk: string | Buffer) => {
        this.handleWorkerStdout(worker, String(chunk), settleReady)
      })

      child.stderr.on('data', (chunk: string | Buffer) => {
        worker.stderrBuffer += String(chunk)
      })

      child.on('error', (error) => {
        this.failWorker(worker, error)
        settleReady(error)
      })

      child.on('exit', (code, signal) => {
        const workerError = new Error(
          `query-embedding-worker-exited:model=${embeddingModel}:code=${code ?? 'null'}:signal=${
            signal ?? 'null'
          }:stderr=${worker.stderrBuffer.trim() || 'none'}`
        )
        this.failWorker(worker, workerError)
        settleReady(workerError)
      })
    })
  }

  private requestEmbedding(
    worker: QueryEmbeddingWorker,
    query: string
  ): Promise<QueryEmbeddingAttempt> {
    if (!worker.child.stdin.writable) {
      throw new Error(`query-embedding-worker-stdin-closed:model=${worker.model}`)
    }

    const requestId = this.nextRequestId++
    const payload = JSON.stringify({
      id: requestId,
      text: query
    })

    return new Promise<QueryEmbeddingAttempt>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        worker.pending.delete(requestId)
        worker.child.kill()
        reject(
          new Error(
            `query-embedding-timeout:model=${worker.model}:timeoutMs=${this.resolveTimeoutMs(worker.model)}`
          )
        )
      }, this.resolveTimeoutMs(worker.model))

      worker.pending.set(requestId, {
        resolve,
        reject,
        timeoutHandle
      })

      worker.child.stdin.write(`${payload}\n`, (error) => {
        if (!error) {
          return
        }

        const pendingRequest = worker.pending.get(requestId)

        if (!pendingRequest) {
          return
        }

        clearTimeout(pendingRequest.timeoutHandle)
        worker.pending.delete(requestId)
        reject(error)
      })
    })
  }

  private handleWorkerStdout(
    worker: QueryEmbeddingWorker,
    chunk: string,
    onReady?: (error?: Error) => void
  ): void {
    worker.stdoutBuffer += chunk

    while (worker.stdoutBuffer.includes('\n')) {
      const newlineIndex = worker.stdoutBuffer.indexOf('\n')
      const line = worker.stdoutBuffer.slice(0, newlineIndex).trim()
      worker.stdoutBuffer = worker.stdoutBuffer.slice(newlineIndex + 1)

      if (!line) {
        continue
      }

      let parsedLine: {
        event?: string
        id?: number
        model?: string
        vector_literal?: string
        error?: string
      }

      try {
        parsedLine = JSON.parse(line) as {
          id?: number
          vector_literal?: string
          error?: string
        }
      } catch {
        continue
      }

      if (parsedLine.event === 'ready') {
        worker.ready = true
        onReady?.()
        continue
      }

      if (typeof parsedLine.id !== 'number') {
        continue
      }

      const pendingRequest = worker.pending.get(parsedLine.id)

      if (!pendingRequest) {
        continue
      }

      clearTimeout(pendingRequest.timeoutHandle)
      worker.pending.delete(parsedLine.id)

      if (parsedLine.vector_literal) {
        pendingRequest.resolve({
          vectorLiteral: parsedLine.vector_literal
        })
        continue
      }

      pendingRequest.resolve({
        reason: parsedLine.error ?? 'query-embedding-vector-missing'
      })
    }
  }

  private failWorker(worker: QueryEmbeddingWorker, error: Error): void {
    const activeWorker = this.workers.get(worker.model)

    if (activeWorker === worker) {
      this.workers.delete(worker.model)
    }

    for (const [requestId, pendingRequest] of worker.pending.entries()) {
      clearTimeout(pendingRequest.timeoutHandle)
      pendingRequest.reject(error)
      worker.pending.delete(requestId)
    }
  }

  private resolveProjectRoot(): string {
    return resolve(__dirname, '../../..')
  }

  private resolveHelperScriptPath(): string {
    return resolve(this.resolveProjectRoot(), 'infra/db/scripts/embed_query.py')
  }

  private resolvePythonBin(): string {
    const configured = process.env.QUERY_EMBED_PYTHON_BIN?.trim()
    return configured && configured.length > 0 ? configured : 'python3'
  }

  private resolveTimeoutMs(embeddingModel: EmbeddingModel): number {
    const modelSpecific =
      embeddingModel === 'qwen3'
        ? process.env.QUERY_EMBED_TIMEOUT_MS_QWEN3
        : process.env.QUERY_EMBED_TIMEOUT_MS_BASE
    const rawTimeout = modelSpecific ?? process.env.QUERY_EMBED_TIMEOUT_MS
    const parsedTimeout = Number(rawTimeout)

    if (Number.isFinite(parsedTimeout) && parsedTimeout > 0) {
      return parsedTimeout
    }

    return embeddingModel === 'qwen3' ? 180_000 : 30_000
  }

  private resolvePrewarmModels(): EmbeddingModel[] {
    const raw = process.env.QUERY_EMBED_PREWARM_MODELS?.trim()

    if (!raw) {
      return []
    }

    const parsed = raw
      .split(',')
      .map((token) => token.trim())
      .filter((token): token is EmbeddingModel => token === 'base' || token === 'qwen3')

    return parsed.filter((token, index, source) => source.indexOf(token) === index)
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) {
      return error.message
    }

    return typeof error === 'string' ? error : 'query-embedding-worker-failed'
  }
}
