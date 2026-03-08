import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards
} from '@nestjs/common'
import type { ApiResponse } from '../types/search-contract'
import { LocalAdminGuard } from './admin-local.guard'
import { AdminService } from './admin.service'
import type {
  Bm25LanguageStatus,
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

  private toErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message.trim()) {
      return error.message
    }

    return fallback
  }
}
