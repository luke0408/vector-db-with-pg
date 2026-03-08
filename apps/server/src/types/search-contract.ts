import type { tags } from 'typia'

export type SearchMode = 'none' | 'hnsw' | 'ivf'
export type EmbeddingModel = 'base' | 'qwen3'

export interface SearchRequest {
  query: string & tags.MinLength<1> & tags.MaxLength<200>
  offset?: number & tags.Type<'int32'> & tags.Minimum<0>
  limit?: number & tags.Type<'int32'> & tags.Minimum<1> & tags.Maximum<100>
  tableName?: string
  embeddingModel?: EmbeddingModel
}

export interface SearchHybridRequest extends SearchRequest {
  mode?: SearchMode
  bm25Enabled?: boolean
  hybridRatio?: number & tags.Minimum<0> & tags.Maximum<100>
}

export interface ApiMeta {
  total: number
  offset: number
  limit: number
  tookMs?: number
  requestId?: string
  embeddingModelUsed?: EmbeddingModel
  tableNameUsed?: string
  languageUsed?: string
}

export interface ApiResponse<T> {
  success: boolean
  data: T[]
  error?: string
  meta?: ApiMeta
}
