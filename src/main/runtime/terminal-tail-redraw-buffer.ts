import {
  hasCanonicalNumericCsiParams,
  parseAnsiControlSequence
} from './terminal-ansi-normalization'
import { ownRetainedString } from '../../shared/own-retained-string'
import { clampTerminalPreviewCursor, trimTerminalLineRight } from './terminal-tail-line-controls'
import { MAX_TAIL_CHARS, MAX_TAIL_LINES, MAX_TAIL_PARTIAL_CHARS } from './terminal-tail-limits'

export function appendNormalizedToMultilineTailBufferUnwindowed(
  previousLines: string[],
  boundedPreviousPartialLine: string,
  normalizedChunk: string,
  previousPartialWasCapped: boolean,
  previousRedrawCursor: RetainedTailRedrawCursor | null
): {
  lines: string[]
  partialLine: string
  redrawCursor: RetainedTailRedrawCursor | null
  truncated: boolean
  newCompleteLines: number
  newlyCompletedLines: string[]
} {
  const rows: RetainedTerminalRow[] = [
    ...previousLines.map((line) => ({ text: line, cells: null, completed: true })),
    { text: boundedPreviousPartialLine, cells: null, completed: false }
  ]
  let cursorRow = previousRedrawCursor
    ? Math.max(0, rows.length - 1 - previousRedrawCursor.rowFromEnd)
    : rows.length - 1
  let cursorColumn = previousRedrawCursor?.column ?? boundedPreviousPartialLine.length
  let newCompleteLines = 0
  const newlyCompletedLines: string[] = []
  let newlyCompletedLineCharacters = 0
  let newlyCompletedLineStart = 0
  let truncated = previousPartialWasCapped

  const retainNewlyCompletedLine = (line: string): void => {
    newlyCompletedLines.push(line)
    newlyCompletedLineCharacters += line.length
    while (
      newlyCompletedLines.length - newlyCompletedLineStart > MAX_TAIL_LINES ||
      newlyCompletedLineCharacters > MAX_TAIL_CHARS
    ) {
      newlyCompletedLineCharacters -= newlyCompletedLines[newlyCompletedLineStart]!.length
      newlyCompletedLineStart += 1
    }
    // Why: a single PTY chunk can carry unbounded newlines; compact in batches while retaining the suffix needed for stable pagination.
    if (newlyCompletedLineStart >= MAX_TAIL_LINES) {
      newlyCompletedLines.splice(0, newlyCompletedLineStart)
      newlyCompletedLineStart = 0
    }
  }

  const ensureCursorRow = (): void => {
    while (cursorRow >= rows.length) {
      rows.push({ text: '', cells: null, completed: false })
    }
  }
  // Rows before this index are already dropped by the line cap but not yet spliced out.
  let trimmedRows = 0
  const trimRows = (): void => {
    const excess = rows.length - trimmedRows - (MAX_TAIL_LINES + 1)
    if (excess <= 0) {
      return
    }
    trimmedRows += excess
    truncated = true
    // Why batched: splicing one row off a full tail per newline made a long chunk, such as a TUI
    // replaying its whole history, cost O(lines x MAX_TAIL_LINES).
    if (trimmedRows >= MAX_TAIL_LINES) {
      spliceTrimmedRows()
    }
  }
  const spliceTrimmedRows = (): void => {
    rows.splice(0, trimmedRows)
    cursorRow -= trimmedRows
    trimmedRows = 0
  }
  const moveCursorToColumn = (nextColumn: number): void => {
    cursorColumn = clampTerminalPreviewCursor(nextColumn)
  }
  const cursorRowCells = (): string[] => {
    ensureCursorRow()
    const row = rows[cursorRow]!
    row.completed = false
    if (row.cells === null) {
      row.cells = row.text.split('')
    }
    return row.cells
  }
  // Why cells: rebuilding the row string per character flattened it every write, so redrawing an
  // N-column row cost O(N^2) and pinned main on full-width TUI repaints (#11315).
  const writeText = (start: number, end: number): void => {
    const cells = cursorRowCells()
    if (cursorColumn > cells.length) {
      const oldLength = cells.length
      cells.length = cursorColumn
      cells.fill(' ', oldLength, cursorColumn)
    }
    for (let index = start; index < end; index += 1) {
      cells[cursorColumn] = normalizedChunk[index]!
      cursorColumn += 1
    }
  }
  const eraseLine = (mode: number): void => {
    const cells = cursorRowCells()
    if (mode === 0) {
      if (cursorColumn < cells.length) {
        cells.length = cursorColumn
      }
    } else if (mode === 1) {
      cells.fill(' ', 0, Math.min(cursorColumn + 1, cells.length))
    } else if (mode === 2) {
      cells.length = 0
    }
  }

  for (let index = 0; index < normalizedChunk.length; index += 1) {
    const char = normalizedChunk[index]
    if (char === '\n') {
      ensureCursorRow()
      const row = rows[cursorRow]!
      row.completed = true
      newCompleteLines += 1
      retainNewlyCompletedLine(trimTerminalLineRight(retainedRowText(row)))
      cursorRow += 1
      cursorColumn = 0
      ensureCursorRow()
      trimRows()
      continue
    }
    if (char === '\r') {
      cursorColumn = 0
      continue
    }
    if (char === '\u0008') {
      cursorColumn = Math.max(0, cursorColumn - 1)
      continue
    }
    if (char === '\u001b') {
      const parsed = parseAnsiControlSequence(normalizedChunk, index)
      if (!parsed) {
        continue
      }
      index = parsed.endIndex
      if (parsed.kind !== 'csi' || !hasCanonicalNumericCsiParams(parsed.params)) {
        continue
      }
      const firstParam = parsed.firstParam ?? 1
      if (parsed.final === 'A') {
        cursorRow = Math.max(trimmedRows, cursorRow - firstParam)
        rows.splice(cursorRow + 1)
      } else if (parsed.final === 'K') {
        eraseLine(parsed.firstParam ?? 0)
      } else if (parsed.final === 'G' || parsed.final === '`') {
        moveCursorToColumn(firstParam - 1)
      } else if (parsed.final === 'D') {
        cursorColumn = Math.max(0, cursorColumn - firstParam)
      } else if (parsed.final === 'C') {
        moveCursorToColumn(cursorColumn + firstParam)
      }
      continue
    }
    let textEnd = index + 1
    while (
      textEnd < normalizedChunk.length &&
      !isRedrawControlCode(normalizedChunk.charCodeAt(textEnd))
    ) {
      textEnd += 1
    }
    writeText(index, textEnd)
    index = textEnd - 1
  }

  spliceTrimmedRows()
  return finalizeRetainedTerminalRows(
    rows,
    cursorRow,
    cursorColumn,
    truncated,
    newCompleteLines,
    newlyCompletedLineStart > 0
      ? newlyCompletedLines.slice(newlyCompletedLineStart)
      : newlyCompletedLines
  )
}

function isRedrawControlCode(code: number): boolean {
  return code === 0x0a || code === 0x0d || code === 0x08 || code === 0x1b
}

export type RetainedTailRedrawCursor = {
  rowFromEnd: number
  column: number
}

type RetainedTerminalRow = {
  text: string
  /** Mutable cells once the chunk writes to the row; `text` is stale until joined. */
  cells: string[] | null
  completed: boolean
}

// Why keep cells: a later cursor-up can rewrite this row again in the same chunk.
function retainedRowText(row: RetainedTerminalRow): string {
  if (row.cells !== null) {
    row.text = row.cells.join('')
  }
  return row.text
}

function finalizeRetainedTerminalRows(
  rows: RetainedTerminalRow[],
  cursorRow: number,
  cursorColumn: number,
  initialTruncated: boolean,
  newCompleteLines: number,
  newlyCompletedLines: string[]
): {
  lines: string[]
  partialLine: string
  redrawCursor: RetainedTailRedrawCursor | null
  truncated: boolean
  newCompleteLines: number
  newlyCompletedLines: string[]
} {
  let truncated = initialTruncated
  let retainedRows = rows.map((row) => ({
    text: trimTerminalLineRight(row.cells === null ? row.text : row.cells.join('')),
    completed: row.completed
  }))

  if (retainedRows.length > MAX_TAIL_LINES + 1) {
    const removeCount = retainedRows.length - (MAX_TAIL_LINES + 1)
    retainedRows = retainedRows.slice(removeCount)
    cursorRow = Math.max(0, cursorRow - removeCount)
    truncated = true
  }

  let totalChars = retainedRows.reduce((sum, row) => sum + row.text.length, 0)
  let trimStartIndex = 0
  while (trimStartIndex < retainedRows.length - 1 && totalChars > MAX_TAIL_CHARS) {
    totalChars -= retainedRows[trimStartIndex]!.text.length
    trimStartIndex += 1
  }
  if (trimStartIndex > 0) {
    retainedRows = retainedRows.slice(trimStartIndex)
    cursorRow = Math.max(0, cursorRow - trimStartIndex)
    truncated = true
  }
  while (
    retainedRows.length > 1 &&
    cursorRow < retainedRows.length - 1 &&
    retainedRows.at(-1)?.completed === false &&
    retainedRows.at(-1)?.text.length === 0
  ) {
    retainedRows.pop()
  }

  const lastRow = retainedRows.at(-1)
  let partialLine = lastRow && !lastRow.completed ? lastRow.text : ''
  let lines = (lastRow && !lastRow.completed ? retainedRows.slice(0, -1) : retainedRows).map(
    (row) => row.text
  )

  if (partialLine.length > MAX_TAIL_PARTIAL_CHARS) {
    partialLine = partialLine.slice(-MAX_TAIL_PARTIAL_CHARS)
    truncated = true
  }
  if (lines.length > MAX_TAIL_LINES) {
    lines = lines.slice(lines.length - MAX_TAIL_LINES)
    truncated = true
  }
  const outputRowCount = lines.length + 1
  const defaultCursorRow = outputRowCount - 1
  const defaultCursorColumn = partialLine.length
  const redrawCursor =
    cursorRow === defaultCursorRow && cursorColumn === defaultCursorColumn
      ? null
      : {
          rowFromEnd: Math.max(0, outputRowCount - 1 - cursorRow),
          column: clampTerminalPreviewCursor(cursorColumn)
        }

  return {
    lines,
    // Why only the partial: redraw rows are built character by character and never sliced from
    // the chunk, but the partial is re-sliced from its own row on every chunk, so it alone can
    // accumulate a backing string across frames. Owning the rows too costs 20-36% on TUI floods
    // for no measured retention.
    partialLine: ownRetainedString(partialLine),
    redrawCursor,
    truncated,
    newCompleteLines,
    newlyCompletedLines
  }
}
