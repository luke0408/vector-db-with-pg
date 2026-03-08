import { Injectable } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { PrismaService } from '../prisma/prisma.service'
import {
  buildDocumentFrequencyDeltas,
  buildLengthDeltas,
  consolidateQueuedTasks,
  type ClaimedBm25Task
} from './admin-indexing'
import {
  mergeRegisterExistingTableRequest,
  type ExistingManagedTableConfigSnapshot
} from './admin-registration'
import type {
  Bm25IndexingEvent,
  Bm25LanguageStatus,
  Bm25SettingsUpdateRequest,
  ManagedDocumentMutationResult,
  ManagedDocumentUpsertRequest,
  ManagedLanguageSummary,
  ManagedTableSummary,
  RegisterExistingTableRequest,
  RegisterExistingTableResult
} from './admin.types'

interface SupportedLanguageRow {
  language: string
  table_suffix: string
}

interface ManagedTableRow {
  table_name: string
  id_column: string
  doc_hash_column: string | null
  title_column: string
  content_column: string
  textlen_column: string
  fts_column: string
  embedding_column: string
  embedding_hnsw_column: string
  language: string
  embedding_dim: number
  embedding_hnsw_dim: number
  reduction_method: string
  description: string | null
  is_default: boolean
  is_active: boolean
}

interface LanguageSettingsRow {
  language: string
  table_suffix: string
  k1: number
  b: number
  last_indexed_at: Date | null
  managed_table_count: bigint | number
}

interface CountRow {
  count: bigint | number
}

interface ResolvedRegisterExistingTableConfig {
  tableName: string
  language: string
  idColumn: string
  docHashColumn: string | null
  titleColumn: string
  contentColumn: string
  textlenColumn: string
  ftsColumn: string
  embeddingColumn: string
  embeddingHnswColumn: string
  embeddingDim: number
  embeddingHnswDim: number
  reductionMethod: string
  description: string | null
  initializeData: boolean
  makeDefault: boolean
}

const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const DEFAULT_EMBEDDING_DIM = 1024
const DEFAULT_HNSW_DIM = 1024
const DEFAULT_REDUCTION_METHOD = 'prefix_truncation'


type RawClient = Pick<
  PrismaService,
  '$queryRawUnsafe' | '$executeRawUnsafe'
>

interface ComputedFtsPayload {
  ftsText: string
  textlen: number
}

interface ManagedDocumentSnapshot {
  id: number
  docHash: string | null
  title: string | null
  content: string
  textlen: number | null
  ftsText: string | null
}

@Injectable()
export class AdminService {
  private bootstrapPromise: Promise<void> | null = null

  constructor(private readonly prismaService: PrismaService) {}

  async listLanguages(): Promise<ManagedLanguageSummary[]> {
    await this.ensureBootstrap()

    const rows = await this.query<LanguageSettingsRow>(`
      SELECT
        sl.language,
        sl.table_suffix,
        settings.k1,
        settings.b,
        settings.last_indexed_at,
        COUNT(mt.table_name)::bigint AS managed_table_count
      FROM search_supported_languages sl
      JOIN search_bm25_language_settings settings
        ON settings.language = sl.language
      LEFT JOIN search_managed_tables mt
        ON mt.language = sl.language
       AND mt.is_active = TRUE
      GROUP BY sl.language, sl.table_suffix, settings.k1, settings.b, settings.last_indexed_at
      ORDER BY sl.language ASC
    `)

    return Promise.all(
      rows.map(async (row) => {
        const dynamicStats = await this.loadLanguageDynamicStats(
          row.language,
          row.table_suffix
        )

        return {
          language: row.language,
          tableSuffix: row.table_suffix,
          k1: Number(row.k1),
          b: Number(row.b),
          lastIndexedAt: row.last_indexed_at?.toISOString() ?? null,
          managedTableCount: Number(row.managed_table_count ?? 0),
          documentCount: dynamicStats.documentCount,
          tokenCount: dynamicStats.tokenCount,
          pendingTasks: dynamicStats.pendingTasks,
          inProgressTasks: dynamicStats.inProgressTasks,
          completedTasks: dynamicStats.completedTasks
        }
      })
    )
  }

  async listManagedTables(): Promise<ManagedTableSummary[]> {
    await this.ensureBootstrap()

    const rows = await this.query<ManagedTableRow & { last_indexed_at: Date | null }>(`
      SELECT
        mt.table_name,
        mt.id_column,
        mt.doc_hash_column,
        mt.title_column,
        mt.content_column,
        mt.textlen_column,
        mt.fts_column,
        mt.embedding_column,
        mt.embedding_hnsw_column,
        mt.language,
        mt.embedding_dim,
        mt.embedding_hnsw_dim,
        mt.reduction_method,
        mt.description,
        mt.is_default,
        mt.is_active,
        settings.last_indexed_at
      FROM search_managed_tables mt
      LEFT JOIN search_bm25_language_settings settings
        ON settings.language = mt.language
      ORDER BY mt.is_default DESC, mt.table_name ASC
    `)

    return Promise.all(
      rows.map(async (row) => ({
        tableName: row.table_name,
        language: row.language,
        idColumn: row.id_column,
        docHashColumn: row.doc_hash_column,
        titleColumn: row.title_column,
        contentColumn: row.content_column,
        textlenColumn: row.textlen_column,
        ftsColumn: row.fts_column,
        embeddingColumn: row.embedding_column,
        embeddingHnswColumn: row.embedding_hnsw_column,
        embeddingDim: Number(row.embedding_dim),
        embeddingHnswDim: Number(row.embedding_hnsw_dim),
        reductionMethod: row.reduction_method,
        description: row.description,
        isDefault: Boolean(row.is_default),
        isActive: Boolean(row.is_active),
        rowCount: await this.getTableRowCount(row.table_name),
        lastIndexedAt: row.last_indexed_at?.toISOString() ?? null
      }))
    )
  }

  async getBm25LanguageStatus(language: string): Promise<Bm25LanguageStatus> {
    await this.ensureBootstrap()

    const normalizedLanguage = this.normalizeLanguage(language)
    const config = await this.getSupportedLanguage(normalizedLanguage)

    if (!config) {
      throw new Error(`Unsupported text search language: ${normalizedLanguage}`)
    }

    const [settingsRow] = await this.query<{
      k1: number
      b: number
      last_indexed_at: Date | null
    }>(
      `
        SELECT k1, b, last_indexed_at
        FROM search_bm25_language_settings
        WHERE language = $1
      `,
      normalizedLanguage
    )

    const queue = await this.getTaskCounts(config.table_suffix)
    const lengths = await this.getLengthSummary(config.table_suffix)
    const tokens = await this.getTokenSummary(config.table_suffix)
    const managedTables = await this.query<{ table_name: string }>(
      `
        SELECT table_name
        FROM search_managed_tables
        WHERE language = $1 AND is_active = TRUE
        ORDER BY table_name ASC
      `,
      normalizedLanguage
    )

    return {
      language: normalizedLanguage,
      tableSuffix: config.table_suffix,
      k1: Number(settingsRow?.k1 ?? 1.2),
      b: Number(settingsRow?.b ?? 0.75),
      lastIndexedAt: settingsRow?.last_indexed_at?.toISOString() ?? null,
      queue,
      lengths,
      tokens,
      managedTablesUsingLanguage: managedTables.map((row) => row.table_name)
    }
  }

  async registerExistingTable(
    request: RegisterExistingTableRequest
  ): Promise<RegisterExistingTableResult> {
    await this.ensureBootstrap()

    const config = await this.prepareRegistrationConfig(request)

    await this.ensureColumnsForManagedTable(config)
    await this.upsertManagedTable(config)

    if (config.makeDefault) {
      await this.exec(`UPDATE search_managed_tables SET is_default = FALSE WHERE table_name <> $1`, config.tableName)
      await this.exec(`UPDATE search_managed_tables SET is_default = TRUE WHERE table_name = $1`, config.tableName)
    } else {
      const [defaultCountRow] = await this.query<CountRow>(
        `SELECT COUNT(*)::bigint AS count FROM search_managed_tables WHERE is_default = TRUE`
      )

      if (Number(defaultCountRow?.count ?? 0) === 0) {
        await this.exec(`UPDATE search_managed_tables SET is_default = TRUE WHERE table_name = $1`, config.tableName)
      }
    }

    if (config.initializeData) {
      await this.initializeManagedTableData(config)
      await this.rebuildLanguageSnapshot(config.language)
    }

    const [table] = (await this.listManagedTables()).filter(
      (candidate) => candidate.tableName === config.tableName
    )

    if (!table) {
      throw new Error(`Managed table registration failed for ${config.tableName}`)
    }

    const bm25LanguageStatus = await this.getBm25LanguageStatus(config.language)

    return {
      table,
      initializedData: config.initializeData,
      bm25LanguageStatus
    }
  }

  async updateBm25Settings(
    language: string,
    request: Bm25SettingsUpdateRequest
  ): Promise<Bm25LanguageStatus> {
    await this.ensureBootstrap()

    const normalizedLanguage = this.normalizeLanguage(language)
    const supportedLanguage = await this.getSupportedLanguage(normalizedLanguage)

    if (!supportedLanguage) {
      throw new Error(`Unsupported text search language: ${normalizedLanguage}`)
    }

    const nextK1 = request.k1
    const nextB = request.b

    if (nextK1 !== undefined && (!Number.isFinite(nextK1) || nextK1 <= 0)) {
      throw new Error('k1 must be greater than 0')
    }

    if (nextB !== undefined && (!Number.isFinite(nextB) || nextB < 0 || nextB > 1)) {
      throw new Error('b must be between 0 and 1')
    }

    await this.exec(
      `
        UPDATE search_bm25_language_settings
        SET
          k1 = COALESCE($2, k1),
          b = COALESCE($3, b),
          updated_at = NOW()
        WHERE language = $1
      `,
      normalizedLanguage,
      nextK1 ?? null,
      nextB ?? null
    )

    return this.getBm25LanguageStatus(normalizedLanguage)
  }

  async createManagedDocument(
    tableName: string,
    request: ManagedDocumentUpsertRequest
  ): Promise<ManagedDocumentMutationResult> {
    await this.ensureBootstrap()

    const config = await this.getManagedTableRowOrThrow(tableName)

    if (typeof request.content !== 'string') {
      throw new Error('content must be provided as string')
    }

    const title = request.title ?? null
    const content = request.content

    return this.prismaService.$transaction(async (tx) => {
      const ftsPayload = await this.computeFtsPayload(config.language, title, content, tx)
      const insertParams: unknown[] = []
      const columns: string[] = []
      const values: string[] = []

      if (config.doc_hash_column) {
        if (typeof request.docHash !== 'string' || !request.docHash.trim()) {
          throw new Error('docHash is required for this managed table')
        }

        columns.push(this.quoteIdentifier(config.doc_hash_column))
        insertParams.push(request.docHash.trim())
        values.push(`$${insertParams.length}`)
      }

      columns.push(this.quoteIdentifier(config.title_column))
      insertParams.push(title)
      values.push(`$${insertParams.length}`)

      columns.push(this.quoteIdentifier(config.content_column))
      insertParams.push(content)
      values.push(`$${insertParams.length}`)

      columns.push(this.quoteIdentifier(config.textlen_column))
      insertParams.push(ftsPayload.textlen)
      values.push(`$${insertParams.length}`)

      columns.push(this.quoteIdentifier(config.fts_column))
      insertParams.push(ftsPayload.ftsText)
      values.push(`$${insertParams.length}::tsvector`)

      const embeddingLiteral = request.embedding
        ? this.toVectorLiteral(request.embedding, config.embedding_dim, 'embedding')
        : null
      const embeddingHnswLiteral = request.embeddingHnsw
        ? this.toVectorLiteral(
            request.embeddingHnsw,
            config.embedding_hnsw_dim,
            'embeddingHnsw'
          )
        : (embeddingLiteral && config.embedding_dim === config.embedding_hnsw_dim
            ? embeddingLiteral
            : null)

      if (embeddingLiteral) {
        columns.push(this.quoteIdentifier(config.embedding_column))
        insertParams.push(embeddingLiteral)
        values.push(`$${insertParams.length}::vector`)
      }

      if (embeddingHnswLiteral) {
        columns.push(this.quoteIdentifier(config.embedding_hnsw_column))
        insertParams.push(embeddingHnswLiteral)
        values.push(`$${insertParams.length}::vector`)
      }

      const tableSql = this.quoteIdentifier(config.table_name)
      const idColumnSql = this.quoteIdentifier(config.id_column)
      const [inserted] = await this.query<{ id: bigint | number }>(
        `
          INSERT INTO ${tableSql} (${columns.join(', ')})
          VALUES (${values.join(', ')})
          RETURNING ${idColumnSql} AS id
        `,
        tx,
        ...insertParams
      )

      const insertedId = Number(inserted?.id ?? 0)

      await this.enqueueTask(
        config.language,
        {
          taskType: 0,
          tableName: config.table_name,
          id: insertedId,
          oldLen: null,
          oldFtsText: null,
          newLen: ftsPayload.textlen,
          newFtsText: ftsPayload.ftsText
        },
        tx
      )

      return {
        tableName: config.table_name,
        language: config.language,
        id: insertedId,
        taskQueued: true,
        taskType: 'insert'
      }
    })
  }

  async updateManagedDocument(
    tableName: string,
    id: number,
    request: ManagedDocumentUpsertRequest
  ): Promise<ManagedDocumentMutationResult> {
    await this.ensureBootstrap()

    const config = await this.getManagedTableRowOrThrow(tableName)

    return this.prismaService.$transaction(async (tx) => {
      const existing = await this.getManagedDocumentSnapshot(config, id, tx)

      if (!existing) {
        throw new Error(`Document ${id} was not found in ${config.table_name}`)
      }

      const nextTitle = request.title !== undefined ? request.title : existing.title
      const nextContent = request.content !== undefined ? request.content : existing.content

      if (typeof nextContent !== 'string') {
        throw new Error('content must resolve to a string')
      }

      const ftsPayload = await this.computeFtsPayload(
        config.language,
        nextTitle ?? null,
        nextContent,
        tx
      )

      const updates: string[] = []
      const params: unknown[] = []

      if (config.doc_hash_column && request.docHash !== undefined) {
        if (request.docHash !== null && !request.docHash.trim()) {
          throw new Error('docHash cannot be empty')
        }

        params.push(request.docHash === null ? null : request.docHash.trim())
        updates.push(`${this.quoteIdentifier(config.doc_hash_column)} = $${params.length}`)
      }

      if (request.title !== undefined) {
        params.push(request.title)
        updates.push(`${this.quoteIdentifier(config.title_column)} = $${params.length}`)
      }

      if (request.content !== undefined) {
        params.push(request.content)
        updates.push(`${this.quoteIdentifier(config.content_column)} = $${params.length}`)
      }

      const embeddingLiteral = request.embedding
        ? this.toVectorLiteral(request.embedding, config.embedding_dim, 'embedding')
        : null
      const embeddingHnswLiteral = request.embeddingHnsw
        ? this.toVectorLiteral(
            request.embeddingHnsw,
            config.embedding_hnsw_dim,
            'embeddingHnsw'
          )
        : undefined

      if (request.embedding !== undefined) {
        params.push(embeddingLiteral)
        updates.push(`${this.quoteIdentifier(config.embedding_column)} = $${params.length}::vector`)
      }

      if (request.embeddingHnsw !== undefined) {
        params.push(embeddingHnswLiteral ?? null)
        updates.push(`${this.quoteIdentifier(config.embedding_hnsw_column)} = $${params.length}::vector`)
      } else if (
        request.embedding !== undefined &&
        embeddingLiteral &&
        config.embedding_dim === config.embedding_hnsw_dim
      ) {
        params.push(embeddingLiteral)
        updates.push(`${this.quoteIdentifier(config.embedding_hnsw_column)} = $${params.length}::vector`)
      }

      params.push(ftsPayload.textlen)
      updates.push(`${this.quoteIdentifier(config.textlen_column)} = $${params.length}`)
      params.push(ftsPayload.ftsText)
      updates.push(`${this.quoteIdentifier(config.fts_column)} = $${params.length}::tsvector`)

      const tableSql = this.quoteIdentifier(config.table_name)
      const idColumnSql = this.quoteIdentifier(config.id_column)
      params.push(id)

      await this.exec(
        `
          UPDATE ${tableSql}
          SET ${updates.join(', ')}
          WHERE ${idColumnSql} = $${params.length}
        `,
        tx,
        ...params
      )

      await this.enqueueTask(
        config.language,
        {
          taskType: 1,
          tableName: config.table_name,
          id,
          oldLen: existing.textlen,
          oldFtsText: existing.ftsText,
          newLen: ftsPayload.textlen,
          newFtsText: ftsPayload.ftsText
        },
        tx
      )

      return {
        tableName: config.table_name,
        language: config.language,
        id,
        taskQueued: true,
        taskType: 'update'
      }
    })
  }

  async deleteManagedDocument(
    tableName: string,
    id: number
  ): Promise<ManagedDocumentMutationResult> {
    await this.ensureBootstrap()

    const config = await this.getManagedTableRowOrThrow(tableName)

    return this.prismaService.$transaction(async (tx) => {
      const existing = await this.getManagedDocumentSnapshot(config, id, tx)

      if (!existing) {
        throw new Error(`Document ${id} was not found in ${config.table_name}`)
      }

      const tableSql = this.quoteIdentifier(config.table_name)
      const idColumnSql = this.quoteIdentifier(config.id_column)
      await this.exec(
        `DELETE FROM ${tableSql} WHERE ${idColumnSql} = $1`,
        tx,
        id
      )

      await this.enqueueTask(
        config.language,
        {
          taskType: 2,
          tableName: config.table_name,
          id,
          oldLen: existing.textlen,
          oldFtsText: existing.ftsText,
          newLen: null,
          newFtsText: null
        },
        tx
      )

      return {
        tableName: config.table_name,
        language: config.language,
        id,
        taskQueued: true,
        taskType: 'delete'
      }
    })
  }

  async runBm25Indexing(
    language: string,
    chunkSize: number,
    emit: (event: Bm25IndexingEvent) => void,
    isCancelled: () => boolean
  ): Promise<void> {
    await this.ensureBootstrap()

    const normalizedLanguage = this.normalizeLanguage(language)
    const supportedLanguage = await this.getSupportedLanguage(normalizedLanguage)

    if (!supportedLanguage) {
      throw new Error(`Unsupported text search language: ${normalizedLanguage}`)
    }

    const normalizedChunkSize = Math.max(1, Math.min(Math.trunc(chunkSize || 100), 1000))
    const startedAt = Date.now()
    let processedTasks = 0

    emit({
      event: 'started',
      language: normalizedLanguage,
      chunkSize: normalizedChunkSize,
      processedTasks: 0,
      remainingTasks: await this.countRemainingTasks(supportedLanguage.table_suffix)
    })

    await this.deleteCompletedTasks(supportedLanguage.table_suffix)

    while (true) {
      if (isCancelled()) {
        emit({
          event: 'cancelled',
          language: normalizedLanguage,
          chunkSize: normalizedChunkSize,
          processedTasks,
          remainingTasks: await this.countRemainingTasks(supportedLanguage.table_suffix),
          elapsedMs: Date.now() - startedAt
        })
        return
      }

      const claimedTasks = await this.claimTaskChunk(
        supportedLanguage.table_suffix,
        normalizedChunkSize
      )

      if (claimedTasks.length === 0) {
        emit({
          event: 'completed',
          language: normalizedLanguage,
          chunkSize: normalizedChunkSize,
          processedTasks,
          remainingTasks: 0,
          elapsedMs: Date.now() - startedAt
        })
        return
      }

      const consolidated = consolidateQueuedTasks(claimedTasks)
      await this.applyConsolidatedTasks(
        normalizedLanguage,
        supportedLanguage.table_suffix,
        consolidated
      )
      await this.markTasksCompleted(
        supportedLanguage.table_suffix,
        claimedTasks.map((task) => task.rowId)
      )

      processedTasks += claimedTasks.length

      emit({
        event: 'chunk',
        language: normalizedLanguage,
        chunkSize: normalizedChunkSize,
        claimedTasks: claimedTasks.length,
        affectedDocs: consolidated.length,
        processedTasks,
        remainingTasks: await this.countRemainingTasks(supportedLanguage.table_suffix),
        elapsedMs: Date.now() - startedAt
      })
    }
  }
  private async ensureBootstrap(): Promise<void> {
    if (!this.bootstrapPromise) {
      this.bootstrapPromise = this.performBootstrap().catch((error) => {
        this.bootstrapPromise = null
        throw error
      })
    }

    await this.bootstrapPromise
  }

  private async performBootstrap(): Promise<void> {
    await this.ensureFoundationTables()
    const languages = await this.syncSupportedLanguages()
    await this.ensureNamuwikiPhaseOneColumns()
    await this.ensureNamuwikiManagedRegistration(languages)
  }

  private async ensureFoundationTables(): Promise<void> {
    const statements = [
      `CREATE SEQUENCE IF NOT EXISTS global_id_seq`,
      `
        CREATE TABLE IF NOT EXISTS search_supported_languages (
          language TEXT PRIMARY KEY,
          table_suffix TEXT NOT NULL UNIQUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `,
      `
        CREATE TABLE IF NOT EXISTS search_bm25_language_settings (
          language TEXT PRIMARY KEY REFERENCES search_supported_languages(language) ON DELETE CASCADE,
          k1 DOUBLE PRECISION NOT NULL DEFAULT 1.2,
          b DOUBLE PRECISION NOT NULL DEFAULT 0.75,
          last_indexed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `,
      `
        CREATE TABLE IF NOT EXISTS search_managed_tables (
          table_name TEXT PRIMARY KEY,
          id_column TEXT NOT NULL DEFAULT 'id',
          doc_hash_column TEXT,
          title_column TEXT NOT NULL DEFAULT 'title',
          content_column TEXT NOT NULL DEFAULT 'content',
          textlen_column TEXT NOT NULL DEFAULT 'textlen',
          fts_column TEXT NOT NULL DEFAULT 'fts',
          embedding_column TEXT NOT NULL DEFAULT 'embedding_qwen',
          embedding_hnsw_column TEXT NOT NULL DEFAULT 'embedding_hnsw',
          language TEXT NOT NULL REFERENCES search_supported_languages(language),
          embedding_dim INTEGER NOT NULL DEFAULT 1024,
          embedding_hnsw_dim INTEGER NOT NULL DEFAULT 1024,
          reduction_method TEXT NOT NULL DEFAULT 'prefix_truncation',
          description TEXT,
          is_default BOOLEAN NOT NULL DEFAULT FALSE,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_search_managed_tables_default ON search_managed_tables ((is_default)) WHERE is_default = TRUE`,
      `
        CREATE OR REPLACE FUNCTION bm25_tsvector_token_stats(input_vector tsvector)
        RETURNS TABLE(token TEXT, tf INTEGER)
        LANGUAGE sql
        IMMUTABLE
        AS $$
          WITH raw_lexemes AS (
            SELECT
              match[1] AS lexeme,
              match[2] AS positions
            FROM regexp_split_to_table(COALESCE(input_vector::text, ''), E'\\s+') AS part
            CROSS JOIN LATERAL regexp_match(
              part,
              E'^''((?:[^'']|'''')+)''(?::([0-9,]+))?$'
            ) AS match
            WHERE part <> ''
          )
          SELECT
            replace(lexeme, '''''', '''') AS token,
            CASE
              WHEN positions IS NULL OR positions = '' THEN 1
              ELSE COALESCE(array_length(string_to_array(positions, ','), 1), 1)
            END AS tf
          FROM raw_lexemes
          WHERE lexeme IS NOT NULL
        $$
      `
    ]

    for (const statement of statements) {
      await this.exec(statement)
    }
  }

  private async syncSupportedLanguages(): Promise<SupportedLanguageRow[]> {
    const configs = await this.query<{ cfgname: string }>(
      `SELECT cfgname FROM pg_ts_config ORDER BY cfgname ASC`
    )
    const existingRows = await this.query<SupportedLanguageRow>(
      `SELECT language, table_suffix FROM search_supported_languages ORDER BY language ASC`
    )
    const existingByLanguage = new Map(
      existingRows.map((row) => [row.language, row.table_suffix])
    )
    const usedSuffixes = new Map(
      existingRows.map((row) => [row.table_suffix, row.language])
    )

    for (const config of configs) {
      const language = config.cfgname
      const existingSuffix = existingByLanguage.get(language)
      const tableSuffix =
        existingSuffix ?? this.createUniqueSuffix(language, usedSuffixes)

      if (!existingSuffix) {
        usedSuffixes.set(tableSuffix, language)
        await this.exec(
          `
            INSERT INTO search_supported_languages (language, table_suffix)
            VALUES ($1, $2)
            ON CONFLICT (language) DO NOTHING
          `,
          language,
          tableSuffix
        )
      }

      await this.exec(
        `
          INSERT INTO search_bm25_language_settings (language)
          VALUES ($1)
          ON CONFLICT (language) DO NOTHING
        `,
        language
      )

      await this.ensureSupportTables(tableSuffix)
    }

    return this.query<SupportedLanguageRow>(
      `SELECT language, table_suffix FROM search_supported_languages ORDER BY language ASC`
    )
  }

  private async ensureSupportTables(tableSuffix: string): Promise<void> {
    const safeSuffix = this.ensureSafeIdentifier(tableSuffix)
    const lengthTable = this.quoteIdentifier(`bm25length_${safeSuffix}`)
    const tokenTable = this.quoteIdentifier(`bm25tokens_${safeSuffix}`)
    const idfTable = this.quoteIdentifier(`bm25idf_${safeSuffix}`)
    const taskTable = this.quoteIdentifier(`bm25tasks_${safeSuffix}`)

    const statements = [
      `
        CREATE TABLE IF NOT EXISTS ${lengthTable} (
          tablename TEXT PRIMARY KEY,
          recordcount BIGINT NOT NULL DEFAULT 0,
          sumlen BIGINT NOT NULL DEFAULT 0,
          avglen DOUBLE PRECISION NOT NULL DEFAULT 0
        )
      `,
      `
        CREATE TABLE IF NOT EXISTS ${tokenTable} (
          id BIGINT NOT NULL,
          token TEXT NOT NULL,
          tf INTEGER NOT NULL,
          PRIMARY KEY (id, token)
        )
      `,
      `CREATE INDEX IF NOT EXISTS ${this.quoteIdentifier(`idx_bm25tokens_${safeSuffix}_token`)} ON ${tokenTable} (token)`,
      `
        CREATE TABLE IF NOT EXISTS ${idfTable} (
          token TEXT PRIMARY KEY,
          tfdoc BIGINT NOT NULL
        )
      `,
      `
        CREATE TABLE IF NOT EXISTS ${taskTable} (
          row_id BIGSERIAL PRIMARY KEY,
          status SMALLINT NOT NULL DEFAULT 0,
          task_type SMALLINT NOT NULL,
          table_name TEXT NOT NULL,
          id BIGINT NOT NULL,
          old_len INTEGER,
          old_fts TSVECTOR,
          new_len INTEGER,
          new_fts TSVECTOR,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `,
      `CREATE INDEX IF NOT EXISTS ${this.quoteIdentifier(`idx_bm25tasks_${safeSuffix}_status_row`)} ON ${taskTable} (status, row_id)`,
      `CREATE INDEX IF NOT EXISTS ${this.quoteIdentifier(`idx_bm25tasks_${safeSuffix}_id`)} ON ${taskTable} (id)`
    ]

    for (const statement of statements) {
      await this.exec(statement)
    }
  }

  private async ensureNamuwikiPhaseOneColumns(): Promise<void> {
    const namuExists = await this.tableExists('namuwiki_documents')

    if (!namuExists) {
      return
    }

    await this.ensureColumnsForManagedTable({
      tableName: 'namuwiki_documents',
      language: await this.pickDefaultLanguage(),
      idColumn: 'id',
      docHashColumn: 'doc_hash',
      titleColumn: 'title',
      contentColumn: 'content',
      textlenColumn: 'textlen',
      ftsColumn: 'fts',
      embeddingColumn: 'embedding_qwen',
      embeddingHnswColumn: 'embedding_hnsw',
      embeddingDim: DEFAULT_EMBEDDING_DIM,
      embeddingHnswDim: DEFAULT_HNSW_DIM,
      reductionMethod: DEFAULT_REDUCTION_METHOD,
      description: 'Phase 1 managed registration for existing NamuWiki documents.',
      initializeData: false,
      makeDefault: true
    })
  }

  private async ensureNamuwikiManagedRegistration(
    languages: SupportedLanguageRow[]
  ): Promise<void> {
    const namuExists = await this.tableExists('namuwiki_documents')

    if (!namuExists) {
      return
    }

    const preferredLanguage =
      languages.find((row) => row.language === 'korean')?.language ??
      languages.find((row) => row.language === 'simple')?.language ??
      languages[0]?.language ??
      'simple'

    const [defaultCountRow] = await this.query<CountRow>(
      `SELECT COUNT(*)::bigint AS count FROM search_managed_tables WHERE is_default = TRUE`
    )

    await this.exec(
      `
        INSERT INTO search_managed_tables (
          table_name,
          id_column,
          doc_hash_column,
          title_column,
          content_column,
          textlen_column,
          fts_column,
          embedding_column,
          embedding_hnsw_column,
          language,
          embedding_dim,
          embedding_hnsw_dim,
          reduction_method,
          description,
          is_default,
          is_active
        )
        VALUES (
          'namuwiki_documents',
          'id',
          'doc_hash',
          'title',
          'content',
          'textlen',
          'fts',
          'embedding_qwen',
          'embedding_hnsw',
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          TRUE
        )
        ON CONFLICT (table_name) DO NOTHING
      `,
      preferredLanguage,
      DEFAULT_EMBEDDING_DIM,
      DEFAULT_HNSW_DIM,
      DEFAULT_REDUCTION_METHOD,
      'Phase 1 managed registration for existing NamuWiki documents.',
      Number(defaultCountRow?.count ?? 0) === 0
    )
  }

  private async prepareRegistrationConfig(
    request: RegisterExistingTableRequest
  ): Promise<ResolvedRegisterExistingTableConfig> {
    const tableName = this.ensureSafeIdentifier(request.tableName)

    if (!(await this.tableExists(tableName))) {
      throw new Error(`Table does not exist: ${tableName}`)
    }

    const existingConfig = await this.getManagedTableConfig(tableName)
    const merged = mergeRegisterExistingTableRequest(request, existingConfig, {
      language: await this.pickDefaultLanguage(),
      idColumn: 'id',
      titleColumn: 'title',
      contentColumn: 'content',
      textlenColumn: 'textlen',
      ftsColumn: 'fts',
      embeddingColumn: 'embedding_qwen',
      embeddingHnswColumn: 'embedding_hnsw',
      embeddingDim: DEFAULT_EMBEDDING_DIM,
      embeddingHnswDim: DEFAULT_HNSW_DIM,
      reductionMethod: DEFAULT_REDUCTION_METHOD
    })

    const language = this.normalizeLanguage(merged.language)
    const supportedLanguage = await this.getSupportedLanguage(language)

    if (!supportedLanguage) {
      throw new Error(`Unsupported text search language: ${language}`)
    }

    const docHashColumn =
      merged.docHashColumn === null
        ? null
        : this.ensureSafeIdentifier(merged.docHashColumn)

    return {
      tableName,
      language,
      idColumn: this.ensureSafeIdentifier(merged.idColumn),
      docHashColumn,
      titleColumn: this.ensureSafeIdentifier(merged.titleColumn),
      contentColumn: this.ensureSafeIdentifier(merged.contentColumn),
      textlenColumn: this.ensureSafeIdentifier(merged.textlenColumn),
      ftsColumn: this.ensureSafeIdentifier(merged.ftsColumn),
      embeddingColumn: this.ensureSafeIdentifier(merged.embeddingColumn),
      embeddingHnswColumn: this.ensureSafeIdentifier(merged.embeddingHnswColumn),
      embeddingDim: this.toPositiveInt(merged.embeddingDim, DEFAULT_EMBEDDING_DIM),
      embeddingHnswDim: this.toPositiveInt(
        merged.embeddingHnswDim,
        DEFAULT_HNSW_DIM
      ),
      reductionMethod: merged.reductionMethod.trim() || DEFAULT_REDUCTION_METHOD,
      description:
        merged.description === null ? null : merged.description.trim() || null,
      initializeData: merged.initializeData,
      makeDefault:
        request.makeDefault ?? existingConfig?.isDefault ?? tableName === 'namuwiki_documents'
    }
  }

  private async getManagedTableConfig(
    tableName: string
  ): Promise<ExistingManagedTableConfigSnapshot | null> {
    const [row] = await this.query<ManagedTableRow>(
      `
        SELECT
          table_name,
          id_column,
          doc_hash_column,
          title_column,
          content_column,
          textlen_column,
          fts_column,
          embedding_column,
          embedding_hnsw_column,
          language,
          embedding_dim,
          embedding_hnsw_dim,
          reduction_method,
          description,
          is_default,
          is_active
        FROM search_managed_tables
        WHERE table_name = $1
      `,
      tableName
    )

    if (!row) {
      return null
    }

    return {
      tableName: row.table_name,
      language: row.language,
      idColumn: row.id_column,
      docHashColumn: row.doc_hash_column,
      titleColumn: row.title_column,
      contentColumn: row.content_column,
      textlenColumn: row.textlen_column,
      ftsColumn: row.fts_column,
      embeddingColumn: row.embedding_column,
      embeddingHnswColumn: row.embedding_hnsw_column,
      embeddingDim: Number(row.embedding_dim),
      embeddingHnswDim: Number(row.embedding_hnsw_dim),
      reductionMethod: row.reduction_method,
      description: row.description,
      isDefault: Boolean(row.is_default)
    }
  }

  private async ensureColumnsForManagedTable(
    config: ResolvedRegisterExistingTableConfig
  ): Promise<void> {
    const tableSql = this.quoteIdentifier(config.tableName)
    const idColumnSql = this.quoteIdentifier(config.idColumn)
    const textlenColumnSql = this.quoteIdentifier(config.textlenColumn)
    const ftsColumnSql = this.quoteIdentifier(config.ftsColumn)
    const embeddingColumnSql = this.quoteIdentifier(config.embeddingColumn)
    const embeddingHnswColumnSql = this.quoteIdentifier(config.embeddingHnswColumn)

    const statements = [
      `ALTER TABLE ${tableSql} ADD COLUMN IF NOT EXISTS ${textlenColumnSql} INTEGER`,
      `ALTER TABLE ${tableSql} ADD COLUMN IF NOT EXISTS ${ftsColumnSql} TSVECTOR`,
      `ALTER TABLE ${tableSql} ADD COLUMN IF NOT EXISTS ${embeddingColumnSql} VECTOR(${config.embeddingDim})`,
      `ALTER TABLE ${tableSql} ADD COLUMN IF NOT EXISTS ${embeddingHnswColumnSql} VECTOR(${config.embeddingHnswDim})`,
      `ALTER TABLE ${tableSql} ALTER COLUMN ${idColumnSql} SET DEFAULT nextval('global_id_seq')`
    ]

    for (const statement of statements) {
      await this.exec(statement)
    }

    await this.exec(
      `SELECT setval('global_id_seq', GREATEST((SELECT COALESCE(MAX(${idColumnSql}), 0) FROM ${tableSql}), 1), TRUE)`
    )

    await this.exec(
      `CREATE INDEX IF NOT EXISTS ${this.quoteIdentifier(`idx_${config.tableName}_${config.ftsColumn}_gin`)} ON ${tableSql} USING GIN (${ftsColumnSql})`
    )
    await this.exec(
      `CREATE INDEX IF NOT EXISTS ${this.quoteIdentifier(`idx_${config.tableName}_${config.embeddingHnswColumn}_hnsw_cosine`)} ON ${tableSql} USING hnsw (${embeddingHnswColumnSql} vector_cosine_ops)`
    )
  }

  private async upsertManagedTable(
    config: ResolvedRegisterExistingTableConfig
  ): Promise<void> {
    await this.exec(
      `
        INSERT INTO search_managed_tables (
          table_name,
          id_column,
          doc_hash_column,
          title_column,
          content_column,
          textlen_column,
          fts_column,
          embedding_column,
          embedding_hnsw_column,
          language,
          embedding_dim,
          embedding_hnsw_dim,
          reduction_method,
          description,
          is_default,
          is_active,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15, TRUE, NOW()
        )
        ON CONFLICT (table_name)
        DO UPDATE SET
          id_column = EXCLUDED.id_column,
          doc_hash_column = EXCLUDED.doc_hash_column,
          title_column = EXCLUDED.title_column,
          content_column = EXCLUDED.content_column,
          textlen_column = EXCLUDED.textlen_column,
          fts_column = EXCLUDED.fts_column,
          embedding_column = EXCLUDED.embedding_column,
          embedding_hnsw_column = EXCLUDED.embedding_hnsw_column,
          language = EXCLUDED.language,
          embedding_dim = EXCLUDED.embedding_dim,
          embedding_hnsw_dim = EXCLUDED.embedding_hnsw_dim,
          reduction_method = EXCLUDED.reduction_method,
          description = EXCLUDED.description,
          is_default = EXCLUDED.is_default,
          is_active = EXCLUDED.is_active,
          updated_at = NOW()
      `,
      config.tableName,
      config.idColumn,
      config.docHashColumn,
      config.titleColumn,
      config.contentColumn,
      config.textlenColumn,
      config.ftsColumn,
      config.embeddingColumn,
      config.embeddingHnswColumn,
      config.language,
      config.embeddingDim,
      config.embeddingHnswDim,
      config.reductionMethod,
      config.description,
      config.makeDefault
    )
  }

  private async initializeManagedTableData(
    config: ResolvedRegisterExistingTableConfig
  ): Promise<void> {
    const tableSql = this.quoteIdentifier(config.tableName)
    const titleColumnSql = this.quoteIdentifier(config.titleColumn)
    const contentColumnSql = this.quoteIdentifier(config.contentColumn)
    const ftsColumnSql = this.quoteIdentifier(config.ftsColumn)
    const textlenColumnSql = this.quoteIdentifier(config.textlenColumn)

    const ftsExpression = `to_tsvector($1::regconfig, concat_ws(' ', COALESCE(${titleColumnSql}, ''), COALESCE(${contentColumnSql}, '')))`

    await this.exec(
      `
        UPDATE ${tableSql}
        SET
          ${ftsColumnSql} = ${ftsExpression},
          ${textlenColumnSql} = COALESCE(array_length(tsvector_to_array(${ftsExpression}), 1), 0)
      `,
      config.language
    )

    if (
      config.tableName === 'namuwiki_documents' &&
      config.docHashColumn === 'doc_hash' &&
      (await this.tableExists('namuwiki_document_embeddings_qwen'))
    ) {
      const docHashColumnSql = this.quoteIdentifier(config.docHashColumn)
      const embeddingColumnSql = this.quoteIdentifier(config.embeddingColumn)
      const embeddingHnswColumnSql = this.quoteIdentifier(config.embeddingHnswColumn)

      await this.exec(
        `
          UPDATE ${tableSql} AS docs
          SET
            ${embeddingColumnSql} = embeddings.embedding,
            ${embeddingHnswColumnSql} = embeddings.embedding
          FROM namuwiki_document_embeddings_qwen AS embeddings
          WHERE docs.${docHashColumnSql} = embeddings.doc_hash
        `
      )
    }
  }

  private async rebuildLanguageSnapshot(language: string): Promise<void> {
    const supportedLanguage = await this.getSupportedLanguage(language)

    if (!supportedLanguage) {
      throw new Error(`Unsupported text search language: ${language}`)
    }

    const managedTables = await this.query<ManagedTableRow>(
      `
        SELECT
          table_name,
          id_column,
          doc_hash_column,
          title_column,
          content_column,
          textlen_column,
          fts_column,
          embedding_column,
          embedding_hnsw_column,
          language,
          embedding_dim,
          embedding_hnsw_dim,
          reduction_method,
          description,
          is_default,
          is_active
        FROM search_managed_tables
        WHERE language = $1 AND is_active = TRUE
        ORDER BY table_name ASC
      `,
      language
    )

    const lengthTable = this.quoteIdentifier(`bm25length_${supportedLanguage.table_suffix}`)
    const tokenTable = this.quoteIdentifier(`bm25tokens_${supportedLanguage.table_suffix}`)
    const idfTable = this.quoteIdentifier(`bm25idf_${supportedLanguage.table_suffix}`)

    await this.exec(`TRUNCATE TABLE ${lengthTable}`)
    await this.exec(`TRUNCATE TABLE ${tokenTable}`)
    await this.exec(`TRUNCATE TABLE ${idfTable}`)

    for (const table of managedTables) {
      const tableSql = this.quoteIdentifier(table.table_name)
      const idColumnSql = this.quoteIdentifier(table.id_column)
      const textlenColumnSql = this.quoteIdentifier(table.textlen_column)
      const ftsColumnSql = this.quoteIdentifier(table.fts_column)

      await this.exec(
        `
          INSERT INTO ${lengthTable} (tablename, recordcount, sumlen, avglen)
          SELECT
            $1,
            COUNT(*)::bigint,
            COALESCE(SUM(COALESCE(${textlenColumnSql}, 0)), 0)::bigint,
            COALESCE(AVG(COALESCE(${textlenColumnSql}, 0)), 0)::double precision
          FROM ${tableSql}
        `,
        table.table_name
      )

      await this.exec(
        `
          INSERT INTO ${tokenTable} (id, token, tf)
          SELECT
            ${idColumnSql},
            token_stats.token,
            token_stats.tf
          FROM ${tableSql}
          CROSS JOIN LATERAL bm25_tsvector_token_stats(${ftsColumnSql}) AS token_stats
          WHERE ${ftsColumnSql} IS NOT NULL
        `
      )
    }

    await this.exec(
      `
        INSERT INTO ${idfTable} (token, tfdoc)
        SELECT token, COUNT(DISTINCT id)::bigint AS tfdoc
        FROM ${tokenTable}
        GROUP BY token
      `
    )

    await this.exec(
      `UPDATE search_bm25_language_settings SET last_indexed_at = NOW(), updated_at = NOW() WHERE language = $1`,
      language
    )
  }

  private async getManagedTableRowOrThrow(
    tableName: string
  ): Promise<ManagedTableRow> {
    const safeTableName = this.ensureSafeIdentifier(tableName)
    const [row] = await this.query<ManagedTableRow>(
      `
        SELECT
          table_name,
          id_column,
          doc_hash_column,
          title_column,
          content_column,
          textlen_column,
          fts_column,
          embedding_column,
          embedding_hnsw_column,
          language,
          embedding_dim,
          embedding_hnsw_dim,
          reduction_method,
          description,
          is_default,
          is_active
        FROM search_managed_tables
        WHERE table_name = $1 AND is_active = TRUE
      `,
      this.prismaService,
      safeTableName
    )

    if (!row) {
      throw new Error(`Managed table not found or inactive: ${safeTableName}`)
    }

    return row
  }

  private async getManagedDocumentSnapshot(
    config: ManagedTableRow,
    id: number,
    client: RawClient
  ): Promise<ManagedDocumentSnapshot | null> {
    const tableSql = this.quoteIdentifier(config.table_name)
    const idColumnSql = this.quoteIdentifier(config.id_column)
    const titleColumnSql = this.quoteIdentifier(config.title_column)
    const contentColumnSql = this.quoteIdentifier(config.content_column)
    const textlenColumnSql = this.quoteIdentifier(config.textlen_column)
    const ftsColumnSql = this.quoteIdentifier(config.fts_column)
    const docHashSelect = config.doc_hash_column
      ? `${this.quoteIdentifier(config.doc_hash_column)} AS "docHash",`
      : `NULL::text AS "docHash",`

    const [row] = await this.query<{
      id: bigint | number
      docHash: string | null
      title: string | null
      content: string
      textlen: number | null
      ftsText: string | null
    }>(
      `
        SELECT
          ${idColumnSql} AS id,
          ${docHashSelect}
          ${titleColumnSql} AS title,
          ${contentColumnSql} AS content,
          ${textlenColumnSql} AS textlen,
          ${ftsColumnSql}::text AS "ftsText"
        FROM ${tableSql}
        WHERE ${idColumnSql} = $1
      `,
      client,
      id
    )

    if (!row) {
      return null
    }

    return {
      id: Number(row.id),
      docHash: row.docHash,
      title: row.title,
      content: row.content,
      textlen: row.textlen,
      ftsText: row.ftsText
    }
  }

  private async computeFtsPayload(
    language: string,
    title: string | null,
    content: string,
    client: RawClient
  ): Promise<ComputedFtsPayload> {
    const [row] = await this.query<{ fts_text: string; textlen: number }>(
      `
        SELECT
          to_tsvector($1::regconfig, concat_ws(' ', COALESCE($2, ''), COALESCE($3, '')))::text AS fts_text,
          COALESCE(
            array_length(
              tsvector_to_array(
                to_tsvector($1::regconfig, concat_ws(' ', COALESCE($2, ''), COALESCE($3, '')))
              ),
              1
            ),
            0
          )::int AS textlen
      `,
      client,
      language,
      title,
      content
    )

    return {
      ftsText: row?.fts_text ?? '',
      textlen: Number(row?.textlen ?? 0)
    }
  }

  private async enqueueTask(
    language: string,
    payload: {
      taskType: number
      tableName: string
      id: number
      oldLen: number | null
      oldFtsText: string | null
      newLen: number | null
      newFtsText: string | null
    },
    client: RawClient
  ): Promise<void> {
    const supportedLanguage = await this.getSupportedLanguage(language)

    if (!supportedLanguage) {
      throw new Error(`Unsupported text search language: ${language}`)
    }

    const taskTable = this.quoteIdentifier(`bm25tasks_${supportedLanguage.table_suffix}`)
    await this.exec(
      `
        INSERT INTO ${taskTable} (
          status,
          task_type,
          table_name,
          id,
          old_len,
          old_fts,
          new_len,
          new_fts,
          updated_at
        )
        VALUES (
          0,
          $1,
          $2,
          $3,
          $4,
          $5::tsvector,
          $6,
          $7::tsvector,
          NOW()
        )
      `,
      client,
      payload.taskType,
      payload.tableName,
      payload.id,
      payload.oldLen,
      payload.oldFtsText,
      payload.newLen,
      payload.newFtsText
    )
  }

  private async deleteCompletedTasks(tableSuffix: string): Promise<void> {
    const taskTable = this.quoteIdentifier(`bm25tasks_${tableSuffix}`)
    await this.exec(`DELETE FROM ${taskTable} WHERE status = 2`)
  }

  private async claimTaskChunk(
    tableSuffix: string,
    chunkSize: number
  ): Promise<ClaimedBm25Task[]> {
    const taskTable = this.quoteIdentifier(`bm25tasks_${tableSuffix}`)
    const rows = await this.query<{
      rowId: bigint | number
      taskType: number
      tableName: string
      id: bigint | number
      oldLen: number | null
      oldFts: string | null
      newLen: number | null
      newFts: string | null
    }>(
      `
        WITH claimed AS (
          SELECT row_id
          FROM ${taskTable}
          WHERE status = 0
          ORDER BY row_id ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE ${taskTable} tasks
        SET status = 1,
            updated_at = NOW()
        WHERE row_id IN (SELECT row_id FROM claimed)
        RETURNING
          row_id AS "rowId",
          task_type AS "taskType",
          table_name AS "tableName",
          id,
          old_len AS "oldLen",
          old_fts::text AS "oldFts",
          new_len AS "newLen",
          new_fts::text AS "newFts"
      `,
      this.prismaService,
      chunkSize
    )

    return rows.map((row) => ({
      rowId: Number(row.rowId),
      taskType: row.taskType,
      tableName: row.tableName,
      id: Number(row.id),
      oldLen: row.oldLen,
      oldFts: row.oldFts,
      newLen: row.newLen,
      newFts: row.newFts
    }))
  }

  private async applyConsolidatedTasks(
    language: string,
    tableSuffix: string,
    tasks: ReturnType<typeof consolidateQueuedTasks>
  ): Promise<void> {
    if (tasks.length === 0) {
      return
    }

    const lengthTable = this.quoteIdentifier(`bm25length_${tableSuffix}`)
    const tokenTable = this.quoteIdentifier(`bm25tokens_${tableSuffix}`)
    const idfTable = this.quoteIdentifier(`bm25idf_${tableSuffix}`)
    const lengthDeltas = buildLengthDeltas(tasks)
    const docFrequencyDeltas = buildDocumentFrequencyDeltas(tasks)

    await this.prismaService.$transaction(async (tx) => {
      for (const delta of lengthDeltas) {
        await this.exec(
          `
            INSERT INTO ${lengthTable} (tablename, recordcount, sumlen, avglen)
            VALUES (
              $1,
              GREATEST($2, 0),
              GREATEST($3, 0),
              CASE WHEN GREATEST($2, 0) = 0 THEN 0 ELSE GREATEST($3, 0)::double precision / GREATEST($2, 0) END
            )
            ON CONFLICT (tablename)
            DO UPDATE SET
              recordcount = GREATEST(0, ${lengthTable}.recordcount + $2),
              sumlen = GREATEST(0, ${lengthTable}.sumlen + $3),
              avglen = CASE
                WHEN GREATEST(0, ${lengthTable}.recordcount + $2) = 0 THEN 0
                ELSE GREATEST(0, ${lengthTable}.sumlen + $3)::double precision /
                     GREATEST(0, ${lengthTable}.recordcount + $2)
              END
          `,
          tx,
          delta.tableName,
          delta.recordCountDelta,
          delta.sumLenDelta
        )
      }

      for (const task of tasks) {
        await this.exec(`DELETE FROM ${tokenTable} WHERE id = $1`, tx, task.id)

        for (const [token, tf] of task.finalTokens.entries()) {
          await this.exec(
            `
              INSERT INTO ${tokenTable} (id, token, tf)
              VALUES ($1, $2, $3)
              ON CONFLICT (id, token)
              DO UPDATE SET tf = EXCLUDED.tf
            `,
            tx,
            task.id,
            token,
            tf
          )
        }
      }

      for (const [token, delta] of docFrequencyDeltas.entries()) {
        await this.exec(
          `
            INSERT INTO ${idfTable} (token, tfdoc)
            VALUES ($1, GREATEST($2, 0))
            ON CONFLICT (token)
            DO UPDATE SET tfdoc = GREATEST(0, ${idfTable}.tfdoc + $2)
          `,
          tx,
          token,
          delta
        )
      }

      await this.exec(`DELETE FROM ${idfTable} WHERE tfdoc <= 0`, tx)
      await this.exec(
        `UPDATE search_bm25_language_settings SET last_indexed_at = NOW(), updated_at = NOW() WHERE language = $1`,
        tx,
        language
      )
    })
  }

  private async markTasksCompleted(
    tableSuffix: string,
    rowIds: number[]
  ): Promise<void> {
    if (rowIds.length === 0) {
      return
    }

    const taskTable = this.quoteIdentifier(`bm25tasks_${tableSuffix}`)
    await this.exec(
      `UPDATE ${taskTable} SET status = 2, updated_at = NOW() WHERE row_id = ANY($1::bigint[])`,
      rowIds
    )
  }

  private async countRemainingTasks(tableSuffix: string): Promise<number> {
    const taskTable = this.quoteIdentifier(`bm25tasks_${tableSuffix}`)
    const [row] = await this.query<CountRow>(
      `SELECT COUNT(*)::bigint AS count FROM ${taskTable} WHERE status = 0`
    )

    return Number(row?.count ?? 0)
  }

  private toVectorLiteral(
    vector: number[],
    expectedDim: number,
    fieldName: string
  ): string {
    if (!Array.isArray(vector) || vector.length !== expectedDim) {
      throw new Error(`${fieldName} must contain exactly ${expectedDim} numeric values`)
    }

    const normalized = vector.map((value) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${fieldName} must contain only finite numbers`)
      }

      return value
    })

    return `[${normalized.join(',')}]`
  }

  private async loadLanguageDynamicStats(
    language: string,
    tableSuffix: string
  ): Promise<{
    documentCount: number
    tokenCount: number
    pendingTasks: number
    inProgressTasks: number
    completedTasks: number
  }> {
    const [queue, lengths, tokens] = await Promise.all([
      this.getTaskCounts(tableSuffix),
      this.getLengthSummary(tableSuffix),
      this.getTokenSummary(tableSuffix)
    ])

    return {
      documentCount: lengths.totalDocuments,
      tokenCount: tokens.uniqueTokens,
      pendingTasks: queue.pending,
      inProgressTasks: queue.inProgress,
      completedTasks: queue.completed
    }
  }

  private async getTaskCounts(tableSuffix: string): Promise<{
    pending: number
    inProgress: number
    completed: number
  }> {
    const taskTable = this.quoteIdentifier(`bm25tasks_${tableSuffix}`)
    const rows = await this.query<{ status: number; count: bigint | number }>(
      `SELECT status, COUNT(*)::bigint AS count FROM ${taskTable} GROUP BY status`
    )

    const counts = {
      pending: 0,
      inProgress: 0,
      completed: 0
    }

    for (const row of rows) {
      const count = Number(row.count ?? 0)

      if (row.status === 0) {
        counts.pending = count
      } else if (row.status === 1) {
        counts.inProgress = count
      } else if (row.status === 2) {
        counts.completed = count
      }
    }

    return counts
  }

  private async getLengthSummary(tableSuffix: string): Promise<{
    managedTables: number
    totalDocuments: number
    totalLength: number
    averageLength: number
  }> {
    const lengthTable = this.quoteIdentifier(`bm25length_${tableSuffix}`)
    const [row] = await this.query<{
      managed_tables: bigint | number
      total_documents: bigint | number
      total_length: bigint | number
      average_length: number | null
    }>(
      `
        SELECT
          COUNT(*)::bigint AS managed_tables,
          COALESCE(SUM(recordcount), 0)::bigint AS total_documents,
          COALESCE(SUM(sumlen), 0)::bigint AS total_length,
          COALESCE(AVG(avglen), 0)::double precision AS average_length
        FROM ${lengthTable}
      `
    )

    return {
      managedTables: Number(row?.managed_tables ?? 0),
      totalDocuments: Number(row?.total_documents ?? 0),
      totalLength: Number(row?.total_length ?? 0),
      averageLength: Number(row?.average_length ?? 0)
    }
  }

  private async getTokenSummary(tableSuffix: string): Promise<{ uniqueTokens: number }> {
    const idfTable = this.quoteIdentifier(`bm25idf_${tableSuffix}`)
    const [row] = await this.query<CountRow>(
      `SELECT COUNT(*)::bigint AS count FROM ${idfTable}`
    )

    return {
      uniqueTokens: Number(row?.count ?? 0)
    }
  }

  private async getTableRowCount(tableName: string): Promise<number> {
    try {
      const tableSql = this.quoteIdentifier(tableName)
      const [row] = await this.query<CountRow>(
        `SELECT COUNT(*)::bigint AS count FROM ${tableSql}`
      )
      return Number(row?.count ?? 0)
    } catch {
      return 0
    }
  }

  private async getSupportedLanguage(
    language: string
  ): Promise<SupportedLanguageRow | null> {
    const [row] = await this.query<SupportedLanguageRow>(
      `
        SELECT language, table_suffix
        FROM search_supported_languages
        WHERE language = $1
      `,
      language
    )

    return row ?? null
  }

  private async pickDefaultLanguage(): Promise<string> {
    const [preferred] = await this.query<SupportedLanguageRow>(
      `
        SELECT language, table_suffix
        FROM search_supported_languages
        WHERE language IN ('korean', 'simple')
        ORDER BY CASE language WHEN 'korean' THEN 0 WHEN 'simple' THEN 1 ELSE 2 END
        LIMIT 1
      `
    )

    if (preferred) {
      return preferred.language
    }

    const [fallback] = await this.query<SupportedLanguageRow>(
      `SELECT language, table_suffix FROM search_supported_languages ORDER BY language ASC LIMIT 1`
    )

    return fallback?.language ?? 'simple'
  }

  private async tableExists(tableName: string): Promise<boolean> {
    const [row] = await this.query<{ exists: string | null }>(
      `SELECT to_regclass($1)::text AS exists`,
      `public.${tableName}`
    )

    return row?.exists !== null && row?.exists !== undefined
  }

  private createUniqueSuffix(
    language: string,
    usedSuffixes: Map<string, string>
  ): string {
    const normalizedBase = this.toBaseSuffix(language)

    if (!usedSuffixes.has(normalizedBase)) {
      return normalizedBase
    }

    const hashed = `${normalizedBase}_${createHash('sha1')
      .update(language)
      .digest('hex')
      .slice(0, 6)}`

    if (!usedSuffixes.has(hashed)) {
      return hashed
    }

    let counter = 2
    while (usedSuffixes.has(`${hashed}_${counter}`)) {
      counter += 1
    }

    return `${hashed}_${counter}`
  }

  private toBaseSuffix(language: string): string {
    const slug = language
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')

    return this.ensureSafeIdentifier(slug || `lang_${createHash('sha1').update(language).digest('hex').slice(0, 6)}`)
  }

  private normalizeLanguage(language: string): string {
    return language.trim().toLowerCase()
  }

  private ensureSafeIdentifier(identifier: string): string {
    const normalized = identifier.trim()

    if (!SAFE_IDENTIFIER_PATTERN.test(normalized)) {
      throw new Error(`Invalid SQL identifier: ${identifier}`)
    }

    return normalized
  }

  private quoteIdentifier(identifier: string): string {
    const safeIdentifier = this.ensureSafeIdentifier(identifier)
    return `"${safeIdentifier}"`
  }

  private toPositiveInt(value: number | undefined, fallback: number): number {
    if (value === undefined || !Number.isFinite(value)) {
      return fallback
    }

    const normalized = Math.trunc(value)
    return normalized > 0 ? normalized : fallback
  }

  private async query<T>(
    sql: string,
    clientOrParam?: RawClient | unknown,
    ...params: unknown[]
  ): Promise<T[]> {
    const useExplicitClient = this.isRawClient(clientOrParam)
    const client = useExplicitClient ? clientOrParam : this.prismaService
    const values = useExplicitClient
      ? params
      : clientOrParam === undefined
        ? params
        : [clientOrParam, ...params]
    return client.$queryRawUnsafe(sql, ...values) as Promise<T[]>
  }

  private async exec(
    sql: string,
    clientOrParam?: RawClient | unknown,
    ...params: unknown[]
  ): Promise<void> {
    const useExplicitClient = this.isRawClient(clientOrParam)
    const client = useExplicitClient ? clientOrParam : this.prismaService
    const values = useExplicitClient
      ? params
      : clientOrParam === undefined
        ? params
        : [clientOrParam, ...params]
    await client.$executeRawUnsafe(sql, ...values)
  }

  private isRawClient(value: unknown): value is RawClient {
    return Boolean(
      value &&
        typeof value === 'object' &&
        '$queryRawUnsafe' in value &&
        '$executeRawUnsafe' in value
    )
  }
}
