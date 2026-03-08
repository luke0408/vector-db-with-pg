import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards
} from '@nestjs/common'
import type { Request, Response } from 'express'
import type { ApiResponse } from '../types/search-contract'
import { LocalAdminGuard } from './admin-local.guard'
import { AdminService } from './admin.service'
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

@Controller('api/admin')
@UseGuards(LocalAdminGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('languages')
  async listLanguages(): Promise<ApiResponse<ManagedLanguageSummary>> {
    try {
      const languages = await this.adminService.listLanguages()
      return {
        success: true,
        data: languages
      }
    } catch (error) {
      return {
        success: false,
        data: [],
        error: this.toErrorMessage(error, 'Failed to load supported languages')
      }
    }
  }

  @Get('tables')
  async listManagedTables(): Promise<ApiResponse<ManagedTableSummary>> {
    try {
      const tables = await this.adminService.listManagedTables()
      return {
        success: true,
        data: tables
      }
    } catch (error) {
      return {
        success: false,
        data: [],
        error: this.toErrorMessage(error, 'Failed to load managed tables')
      }
    }
  }

  @Get('bm25/:language/status')
  async getBm25LanguageStatus(
    @Param('language') language: string
  ): Promise<ApiResponse<Bm25LanguageStatus>> {
    try {
      const status = await this.adminService.getBm25LanguageStatus(language)
      return {
        success: true,
        data: [status]
      }
    } catch (error) {
      return {
        success: false,
        data: [],
        error: this.toErrorMessage(error, 'Failed to load BM25 language status')
      }
    }
  }

  @Patch('bm25/:language/settings')
  async updateBm25Settings(
    @Param('language') language: string,
    @Body() body: unknown
  ): Promise<ApiResponse<Bm25LanguageStatus>> {
    const parsedRequest = this.parseBm25SettingsUpdateRequest(body)

    if (parsedRequest.error) {
      return {
        success: false,
        data: [],
        error: parsedRequest.error
      }
    }

    try {
      const status = await this.adminService.updateBm25Settings(
        language,
        parsedRequest.value
      )
      return {
        success: true,
        data: [status]
      }
    } catch (error) {
      return {
        success: false,
        data: [],
        error: this.toErrorMessage(error, 'Failed to update BM25 settings')
      }
    }
  }

  @Get('bm25/:language/run')
  async runBm25Indexing(
    @Param('language') language: string,
    @Query('chunkSize') chunkSize: string | undefined,
    @Req() request: Request,
    @Res() response: Response
  ): Promise<void> {
    const parsedChunkSize = this.parseChunkSize(chunkSize)

    if (parsedChunkSize.error) {
      response.status(400).json({
        success: false,
        data: [],
        error: parsedChunkSize.error
      })
      return
    }

    let cancelled = false
    request.on('close', () => {
      cancelled = true
    })

    response.setHeader('Content-Type', 'text/event-stream')
    response.setHeader('Cache-Control', 'no-cache, no-transform')
    response.setHeader('Connection', 'keep-alive')
    response.flushHeaders?.()

    const emit = (event: Bm25IndexingEvent): void => {
      response.write(`event: ${event.event}\n`)
      response.write(`data: ${JSON.stringify(event)}\n\n`)
    }

    try {
      await this.adminService.runBm25Indexing(
        language,
        parsedChunkSize.value,
        emit,
        () => cancelled
      )
    } catch (error) {
      emit({
        event: 'error',
        language,
        chunkSize: parsedChunkSize.value,
        message: this.toErrorMessage(error, 'Failed to run BM25 indexing')
      })
    } finally {
      response.end()
    }
  }

  @Post('tables/register-existing')
  async registerExistingTable(
    @Body() body: unknown
  ): Promise<ApiResponse<RegisterExistingTableResult>> {
    const parsedRequest = this.parseRegisterExistingTableRequest(body)

    if (parsedRequest.error) {
      return {
        success: false,
        data: [],
        error: parsedRequest.error
      }
    }

    try {
      const result = await this.adminService.registerExistingTable(parsedRequest.value)
      return {
        success: true,
        data: [result]
      }
    } catch (error) {
      return {
        success: false,
        data: [],
        error: this.toErrorMessage(error, 'Failed to register existing table')
      }
    }
  }

  @Post('documents/:tableName')
  async createManagedDocument(
    @Param('tableName') tableName: string,
    @Body() body: unknown
  ): Promise<ApiResponse<ManagedDocumentMutationResult>> {
    const parsedRequest = this.parseManagedDocumentUpsertRequest(body)

    if (parsedRequest.error) {
      return {
        success: false,
        data: [],
        error: parsedRequest.error
      }
    }

    try {
      const result = await this.adminService.createManagedDocument(
        tableName,
        parsedRequest.value
      )
      return {
        success: true,
        data: [result]
      }
    } catch (error) {
      return {
        success: false,
        data: [],
        error: this.toErrorMessage(error, 'Failed to create managed document')
      }
    }
  }

  @Put('documents/:tableName/:id')
  async updateManagedDocument(
    @Param('tableName') tableName: string,
    @Param('id') id: string,
    @Body() body: unknown
  ): Promise<ApiResponse<ManagedDocumentMutationResult>> {
    const parsedId = this.parseDocumentId(id)

    if (parsedId.error) {
      return {
        success: false,
        data: [],
        error: parsedId.error
      }
    }

    const parsedRequest = this.parseManagedDocumentUpsertRequest(body)

    if (parsedRequest.error) {
      return {
        success: false,
        data: [],
        error: parsedRequest.error
      }
    }

    try {
      const result = await this.adminService.updateManagedDocument(
        tableName,
        parsedId.value,
        parsedRequest.value
      )
      return {
        success: true,
        data: [result]
      }
    } catch (error) {
      return {
        success: false,
        data: [],
        error: this.toErrorMessage(error, 'Failed to update managed document')
      }
    }
  }

  @Delete('documents/:tableName/:id')
  async deleteManagedDocument(
    @Param('tableName') tableName: string,
    @Param('id') id: string
  ): Promise<ApiResponse<ManagedDocumentMutationResult>> {
    const parsedId = this.parseDocumentId(id)

    if (parsedId.error) {
      return {
        success: false,
        data: [],
        error: parsedId.error
      }
    }

    try {
      const result = await this.adminService.deleteManagedDocument(
        tableName,
        parsedId.value
      )
      return {
        success: true,
        data: [result]
      }
    } catch (error) {
      return {
        success: false,
        data: [],
        error: this.toErrorMessage(error, 'Failed to delete managed document')
      }
    }
  }

  private parseRegisterExistingTableRequest(
    body: unknown
  ): { value: RegisterExistingTableRequest; error?: string } {
    const rawRequest = this.toRegisterExistingCandidate(body)

    if (!rawRequest?.tableName) {
      return {
        value: {
          tableName: 'namuwiki_documents'
        },
        error: 'tableName must be provided as string'
      }
    }

    return {
      value: {
        tableName: rawRequest.tableName.trim(),
        language: rawRequest.language?.trim(),
        idColumn: rawRequest.idColumn?.trim(),
        docHashColumn: rawRequest.docHashColumn?.trim() ?? rawRequest.docHashColumn,
        titleColumn: rawRequest.titleColumn?.trim(),
        contentColumn: rawRequest.contentColumn?.trim(),
        textlenColumn: rawRequest.textlenColumn?.trim(),
        ftsColumn: rawRequest.ftsColumn?.trim(),
        embeddingColumn: rawRequest.embeddingColumn?.trim(),
        embeddingHnswColumn: rawRequest.embeddingHnswColumn?.trim(),
        embeddingDim: rawRequest.embeddingDim,
        embeddingHnswDim: rawRequest.embeddingHnswDim,
        reductionMethod: rawRequest.reductionMethod?.trim(),
        description: rawRequest.description?.trim(),
        initializeData: rawRequest.initializeData,
        makeDefault: rawRequest.makeDefault
      }
    }
  }

  private toRegisterExistingCandidate(
    value: unknown
  ): Partial<RegisterExistingTableRequest> | null {
    if (typeof value !== 'object' || value === null) {
      return null
    }

    const raw = value as Record<string, unknown>

    return {
      tableName: this.pickOptionalString(raw, 'tableName'),
      language: this.pickOptionalString(raw, 'language'),
      idColumn: this.pickOptionalString(raw, 'idColumn'),
      docHashColumn: this.pickNullableString(raw, 'docHashColumn'),
      titleColumn: this.pickOptionalString(raw, 'titleColumn'),
      contentColumn: this.pickOptionalString(raw, 'contentColumn'),
      textlenColumn: this.pickOptionalString(raw, 'textlenColumn'),
      ftsColumn: this.pickOptionalString(raw, 'ftsColumn'),
      embeddingColumn: this.pickOptionalString(raw, 'embeddingColumn'),
      embeddingHnswColumn: this.pickOptionalString(raw, 'embeddingHnswColumn'),
      embeddingDim: this.pickOptionalNumber(raw, 'embeddingDim'),
      embeddingHnswDim: this.pickOptionalNumber(raw, 'embeddingHnswDim'),
      reductionMethod: this.pickOptionalString(raw, 'reductionMethod'),
      description: this.pickOptionalString(raw, 'description'),
      initializeData: this.pickOptionalBoolean(raw, 'initializeData'),
      makeDefault: this.pickOptionalBoolean(raw, 'makeDefault')
    }
  }

  private parseBm25SettingsUpdateRequest(
    body: unknown
  ): { value: Bm25SettingsUpdateRequest; error?: string } {
    if (typeof body !== 'object' || body === null) {
      return {
        value: {},
        error: 'Request body must be an object'
      }
    }

    const raw = body as Record<string, unknown>
    const k1 = this.pickOptionalNumber(raw, 'k1')
    const b = this.pickOptionalNumber(raw, 'b')

    if (k1 === undefined && b === undefined) {
      return {
        value: {},
        error: 'At least one of k1 or b must be provided'
      }
    }

    return {
      value: { k1, b }
    }
  }

  private parseManagedDocumentUpsertRequest(
    body: unknown
  ): { value: ManagedDocumentUpsertRequest; error?: string } {
    if (typeof body !== 'object' || body === null) {
      return {
        value: {},
        error: 'Request body must be an object'
      }
    }

    const raw = body as Record<string, unknown>
    const request: ManagedDocumentUpsertRequest = {}

    if ('docHash' in raw) {
      const docHash = this.pickNullableString(raw, 'docHash')
      if (docHash === undefined) {
        return {
          value: {},
          error: 'docHash must be a string or null'
        }
      }
      request.docHash = docHash
    }

    if ('title' in raw) {
      const title = this.pickNullableString(raw, 'title')
      if (title === undefined) {
        return {
          value: {},
          error: 'title must be a string or null'
        }
      }
      request.title = title
    }

    if ('content' in raw) {
      const content = raw.content
      if (typeof content !== 'string') {
        return {
          value: {},
          error: 'content must be a string'
        }
      }
      request.content = content
    }

    if ('embedding' in raw) {
      const embedding = this.pickNullableNumberArray(raw, 'embedding')
      if (embedding === undefined) {
        return {
          value: {},
          error: 'embedding must be an array of finite numbers or null'
        }
      }
      request.embedding = embedding
    }

    if ('embeddingHnsw' in raw) {
      const embeddingHnsw = this.pickNullableNumberArray(raw, 'embeddingHnsw')
      if (embeddingHnsw === undefined) {
        return {
          value: {},
          error: 'embeddingHnsw must be an array of finite numbers or null'
        }
      }
      request.embeddingHnsw = embeddingHnsw
    }

    return {
      value: request
    }
  }

  private parseDocumentId(value: string): { value: number; error?: string } {
    const parsed = Number(value)

    if (!Number.isInteger(parsed) || parsed <= 0) {
      return {
        value: 0,
        error: 'id must be a positive integer'
      }
    }

    return {
      value: parsed
    }
  }

  private parseChunkSize(value: string | undefined): { value: number; error?: string } {
    if (value === undefined || value.trim() === '') {
      return { value: 100 }
    }

    const parsed = Number(value)

    if (!Number.isInteger(parsed) || parsed <= 0) {
      return {
        value: 100,
        error: 'chunkSize must be a positive integer'
      }
    }

    return {
      value: parsed
    }
  }

  private pickOptionalString(
    value: Record<string, unknown>,
    key: string
  ): string | undefined {
    if (!(key in value)) {
      return undefined
    }

    const raw = value[key]
    return typeof raw === 'string' ? raw : undefined
  }

  private pickNullableString(
    value: Record<string, unknown>,
    key: string
  ): string | null | undefined {
    if (!(key in value)) {
      return undefined
    }

    const raw = value[key]

    if (raw === null) {
      return null
    }

    return typeof raw === 'string' ? raw : undefined
  }

  private pickOptionalNumber(
    value: Record<string, unknown>,
    key: string
  ): number | undefined {
    if (!(key in value)) {
      return undefined
    }

    const raw = value[key]

    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return raw
    }

    if (typeof raw === 'string' && raw.trim()) {
      const parsed = Number(raw)
      return Number.isFinite(parsed) ? parsed : undefined
    }

    return undefined
  }

  private pickOptionalBoolean(
    value: Record<string, unknown>,
    key: string
  ): boolean | undefined {
    if (!(key in value)) {
      return undefined
    }

    const raw = value[key]
    return typeof raw === 'boolean' ? raw : undefined
  }

  private pickNullableNumberArray(
    value: Record<string, unknown>,
    key: string
  ): number[] | null | undefined {
    if (!(key in value)) {
      return undefined
    }

    const raw = value[key]

    if (raw === null) {
      return null
    }

    if (!Array.isArray(raw)) {
      return undefined
    }

    const values = raw.map((entry) => {
      if (typeof entry !== 'number' || !Number.isFinite(entry)) {
        return Number.NaN
      }
      return entry
    })

    return values.every((entry) => Number.isFinite(entry)) ? values : undefined
  }

  private toErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message.trim()) {
      return error.message
    }

    return fallback
  }
}
