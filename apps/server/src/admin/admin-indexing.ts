export interface ClaimedBm25Task {
  rowId: number
  taskType: number
  tableName: string
  id: number
  oldLen: number | null
  oldFts: string | null
  newLen: number | null
  newFts: string | null
}

export interface ConsolidatedBm25Task {
  tableName: string
  id: number
  initialLen: number | null
  initialTokens: Map<string, number>
  finalLen: number | null
  finalTokens: Map<string, number>
  claimedRowIds: number[]
}

export interface TableLengthDelta {
  tableName: string
  recordCountDelta: number
  sumLenDelta: number
}

export function parseTsvectorText(tsvector: string | null | undefined): Map<string, number> {
  const tokens = new Map<string, number>()

  if (!tsvector) {
    return tokens
  }

  const regex = /'((?:[^']|'')+)'(?::([0-9,]+))?/g
  for (const match of tsvector.matchAll(regex)) {
    const token = match[1].replace(/''/g, "'")
    const positions = match[2]
    const tf = positions && positions.length > 0 ? positions.split(',').length : 1
    tokens.set(token, tf)
  }

  return tokens
}

export function consolidateQueuedTasks(
  tasks: ClaimedBm25Task[]
): ConsolidatedBm25Task[] {
  const grouped = new Map<string, ClaimedBm25Task[]>()

  for (const task of tasks) {
    const key = `${task.tableName}::${task.id}`
    const bucket = grouped.get(key)

    if (bucket) {
      bucket.push(task)
    } else {
      grouped.set(key, [task])
    }
  }

  return Array.from(grouped.values()).map((bucket) => {
    const sorted = [...bucket].sort((left, right) => left.rowId - right.rowId)
    const first = sorted[0]
    const last = sorted[sorted.length - 1]

    return {
      tableName: first.tableName,
      id: first.id,
      initialLen: first.oldLen,
      initialTokens: parseTsvectorText(first.oldFts),
      finalLen: last.newLen,
      finalTokens: parseTsvectorText(last.newFts),
      claimedRowIds: sorted.map((task) => task.rowId)
    }
  })
}

export function buildLengthDeltas(
  tasks: ConsolidatedBm25Task[]
): TableLengthDelta[] {
  const deltas = new Map<string, TableLengthDelta>()

  for (const task of tasks) {
    const existing = deltas.get(task.tableName) ?? {
      tableName: task.tableName,
      recordCountDelta: 0,
      sumLenDelta: 0
    }

    const initialExists = task.initialLen !== null
    const finalExists = task.finalLen !== null

    if (!initialExists && finalExists) {
      existing.recordCountDelta += 1
    } else if (initialExists && !finalExists) {
      existing.recordCountDelta -= 1
    }

    existing.sumLenDelta += (task.finalLen ?? 0) - (task.initialLen ?? 0)
    deltas.set(task.tableName, existing)
  }

  return Array.from(deltas.values())
}

export function buildTokenDeltas(
  tasks: ConsolidatedBm25Task[]
): Map<string, number> {
  const deltas = new Map<string, number>()

  for (const task of tasks) {
    applyTokenDelta(deltas, task.initialTokens, -1)
    applyTokenDelta(deltas, task.finalTokens, 1)
  }

  return cleanupZeroEntries(deltas)
}

export function buildDocumentFrequencyDeltas(
  tasks: ConsolidatedBm25Task[]
): Map<string, number> {
  const deltas = new Map<string, number>()

  for (const task of tasks) {
    const initialKeys = new Set(task.initialTokens.keys())
    const finalKeys = new Set(task.finalTokens.keys())

    for (const token of initialKeys) {
      if (!finalKeys.has(token)) {
        deltas.set(token, (deltas.get(token) ?? 0) - 1)
      }
    }

    for (const token of finalKeys) {
      if (!initialKeys.has(token)) {
        deltas.set(token, (deltas.get(token) ?? 0) + 1)
      }
    }
  }

  return cleanupZeroEntries(deltas)
}

function applyTokenDelta(
  target: Map<string, number>,
  source: Map<string, number>,
  direction: 1 | -1
): void {
  for (const [token, tf] of source.entries()) {
    target.set(token, (target.get(token) ?? 0) + tf * direction)
  }
}

function cleanupZeroEntries(source: Map<string, number>): Map<string, number> {
  for (const [token, delta] of source.entries()) {
    if (delta === 0) {
      source.delete(token)
    }
  }

  return source
}
