import type { RegisterExistingTableRequest } from './admin.types'

export interface ExistingManagedTableConfigSnapshot {
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
  isDefault: boolean
}

export interface RegistrationFallbackDefaults {
  language: string
  idColumn: string
  titleColumn: string
  contentColumn: string
  textlenColumn: string
  ftsColumn: string
  embeddingColumn: string
  embeddingHnswColumn: string
  embeddingDim: number
  embeddingHnswDim: number
  reductionMethod: string
}

export interface RegistrationDraftConfig {
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
  makeDefault: boolean
}

export function mergeRegisterExistingTableRequest(
  request: RegisterExistingTableRequest,
  existing: ExistingManagedTableConfigSnapshot | null,
  defaults: RegistrationFallbackDefaults
): RegistrationDraftConfig {
  return {
    tableName: request.tableName,
    language: request.language ?? existing?.language ?? defaults.language,
    idColumn: request.idColumn ?? existing?.idColumn ?? defaults.idColumn,
    docHashColumn:
      request.docHashColumn !== undefined
        ? request.docHashColumn
        : (existing?.docHashColumn ?? null),
    titleColumn: request.titleColumn ?? existing?.titleColumn ?? defaults.titleColumn,
    contentColumn:
      request.contentColumn ?? existing?.contentColumn ?? defaults.contentColumn,
    textlenColumn:
      request.textlenColumn ?? existing?.textlenColumn ?? defaults.textlenColumn,
    ftsColumn: request.ftsColumn ?? existing?.ftsColumn ?? defaults.ftsColumn,
    embeddingColumn:
      request.embeddingColumn ?? existing?.embeddingColumn ?? defaults.embeddingColumn,
    embeddingHnswColumn:
      request.embeddingHnswColumn ??
      existing?.embeddingHnswColumn ??
      defaults.embeddingHnswColumn,
    embeddingDim:
      request.embeddingDim ?? existing?.embeddingDim ?? defaults.embeddingDim,
    embeddingHnswDim:
      request.embeddingHnswDim ?? existing?.embeddingHnswDim ?? defaults.embeddingHnswDim,
    reductionMethod:
      request.reductionMethod ??
      existing?.reductionMethod ??
      defaults.reductionMethod,
    description:
      request.description !== undefined
        ? request.description
        : (existing?.description ?? null),
    makeDefault: request.makeDefault ?? existing?.isDefault ?? false
  }
}
