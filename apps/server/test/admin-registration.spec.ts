import { mergeRegisterExistingTableRequest } from '../src/admin/admin-registration'

describe('mergeRegisterExistingTableRequest', () => {
  it('preserves existing metadata when request omits optional fields', () => {
    const merged = mergeRegisterExistingTableRequest(
      {
        tableName: 'namuwiki_documents',
        language: 'korean',
        initializeData: false
      },
      {
        tableName: 'namuwiki_documents',
        language: 'korean',
        idColumn: 'id',
        docHashColumn: 'doc_hash',
        titleColumn: 'title',
        contentColumn: 'content',
        textlenColumn: 'textlen',
        ftsColumn: 'fts',
        embeddingColumn: 'embedding_qwen',
        embeddingHnswColumn: 'embedding_hnsw',
        embeddingDim: 1024,
        embeddingHnswDim: 1024,
        reductionMethod: 'prefix_truncation',
        description: 'Existing description',
        isDefault: true
      },
      {
        language: 'simple',
        idColumn: 'id',
        titleColumn: 'title',
        contentColumn: 'content',
        textlenColumn: 'textlen',
        ftsColumn: 'fts',
        embeddingColumn: 'embedding_qwen',
        embeddingHnswColumn: 'embedding_hnsw',
        embeddingDim: 1024,
        embeddingHnswDim: 1024,
        reductionMethod: 'prefix_truncation'
      }
    )

    expect(merged.docHashColumn).toBe('doc_hash')
    expect(merged.description).toBe('Existing description')
    expect(merged.makeDefault).toBe(true)
    expect(merged.embeddingColumn).toBe('embedding_qwen')
    expect(merged.embeddingHnswColumn).toBe('embedding_hnsw')
    expect(merged.initializeData).toBe(false)
  })

  it('allows explicit nullable fields to clear existing metadata', () => {
    const merged = mergeRegisterExistingTableRequest(
      {
        tableName: 'namuwiki_documents',
        docHashColumn: null,
        description: ''
      },
      {
        tableName: 'namuwiki_documents',
        language: 'korean',
        idColumn: 'id',
        docHashColumn: 'doc_hash',
        titleColumn: 'title',
        contentColumn: 'content',
        textlenColumn: 'textlen',
        ftsColumn: 'fts',
        embeddingColumn: 'embedding_qwen',
        embeddingHnswColumn: 'embedding_hnsw',
        embeddingDim: 1024,
        embeddingHnswDim: 1024,
        reductionMethod: 'prefix_truncation',
        description: 'Existing description',
        isDefault: false
      },
      {
        language: 'simple',
        idColumn: 'id',
        titleColumn: 'title',
        contentColumn: 'content',
        textlenColumn: 'textlen',
        ftsColumn: 'fts',
        embeddingColumn: 'embedding_qwen',
        embeddingHnswColumn: 'embedding_hnsw',
        embeddingDim: 1024,
        embeddingHnswDim: 1024,
        reductionMethod: 'prefix_truncation'
      }
    )

    expect(merged.docHashColumn).toBeNull()
    expect(merged.description).toBe('')
    expect(merged.makeDefault).toBe(false)
    expect(merged.initializeData).toBe(true)
  })
})
