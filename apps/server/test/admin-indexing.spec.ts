import {
  buildDocumentFrequencyDeltas,
  buildLengthDeltas,
  buildTokenDeltas,
  consolidateQueuedTasks,
  parseTsvectorText,
  type ClaimedBm25Task
} from '../src/admin/admin-indexing'

describe('admin-indexing helpers', () => {
  it('parses tsvector text with term frequency', () => {
    const parsed = parseTsvectorText("'pok\u00e9mon':1,4 'master':2")

    expect(parsed.get('pok\u00e9mon')).toBe(2)
    expect(parsed.get('master')).toBe(1)
  })

  it('consolidates multiple tasks for the same document into one net delta', () => {
    const tasks: ClaimedBm25Task[] = [
      {
        rowId: 1,
        taskType: 0,
        tableName: 'namuwiki_documents',
        id: 10,
        oldLen: null,
        oldFts: null,
        newLen: 2,
        newFts: "'pok\u00e9mon':1 'master':2"
      },
      {
        rowId: 2,
        taskType: 1,
        tableName: 'namuwiki_documents',
        id: 10,
        oldLen: 2,
        oldFts: "'pok\u00e9mon':1 'master':2",
        newLen: 3,
        newFts: "'pok\u00e9mon':1,3 'league':2"
      }
    ]

    const consolidated = consolidateQueuedTasks(tasks)

    expect(consolidated).toHaveLength(1)
    expect(consolidated[0]).toEqual(
      expect.objectContaining({
        tableName: 'namuwiki_documents',
        id: 10,
        initialLen: null,
        finalLen: 3,
        claimedRowIds: [1, 2]
      })
    )
    expect(consolidated[0].finalTokens.get('pok\u00e9mon')).toBe(2)
    expect(consolidated[0].finalTokens.get('league')).toBe(1)
  })

  it('builds table/token/doc-frequency deltas from consolidated tasks', () => {
    const consolidated = consolidateQueuedTasks([
      {
        rowId: 1,
        taskType: 1,
        tableName: 'namuwiki_documents',
        id: 10,
        oldLen: 2,
        oldFts: "'pok\u00e9mon':1 'master':2",
        newLen: 3,
        newFts: "'pok\u00e9mon':1,3 'league':2"
      },
      {
        rowId: 2,
        taskType: 2,
        tableName: 'namuwiki_documents',
        id: 11,
        oldLen: 1,
        oldFts: "'pikachu':1",
        newLen: null,
        newFts: null
      }
    ])

    const lengthDeltas = buildLengthDeltas(consolidated)
    const tokenDeltas = buildTokenDeltas(consolidated)
    const docFreqDeltas = buildDocumentFrequencyDeltas(consolidated)

    expect(lengthDeltas).toEqual([
      {
        tableName: 'namuwiki_documents',
        recordCountDelta: -1,
        sumLenDelta: 0
      }
    ])
    expect(tokenDeltas.get('master')).toBe(-1)
    expect(tokenDeltas.get('league')).toBe(1)
    expect(tokenDeltas.get('pikachu')).toBe(-1)
    expect(docFreqDeltas.get('master')).toBe(-1)
    expect(docFreqDeltas.get('league')).toBe(1)
    expect(docFreqDeltas.get('pikachu')).toBe(-1)
  })
})
