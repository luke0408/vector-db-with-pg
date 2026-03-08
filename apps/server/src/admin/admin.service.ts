import { Injectable } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { PrismaService } from '../prisma/prisma.service'
import {
  mergeRegisterExistingTableRequest,
  type ExistingManagedTableConfigSnapshot
} from './admin-registration'
import type {
  Bm25LanguageStatus,
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
    ...params: unknown[]
  ): Promise<T[]> {
    return this.prismaService.$queryRawUnsafe(sql, ...params) as Promise<T[]>
  }

  private async exec(sql: string, ...params: unknown[]): Promise<void> {
    await this.prismaService.$executeRawUnsafe(sql, ...params)
  }
}
