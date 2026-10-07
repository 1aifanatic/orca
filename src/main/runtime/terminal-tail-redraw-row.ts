import { ownRetainedString } from '../../shared/own-retained-string'

// Cost model (#11315): per chunk, a row costs O(bytes written to it) plus O(width) once per
// snapshot that follows a real content change. A row the chunk revisits without changing costs
// O(1) per newline, so cursor-up/newline replays of wide rows cannot stall main.
export type RetainedTerminalRow = {
  /** Authoritative while `cells` is null. */
  text: string
  /** True when `text` was concatenated this chunk; reading it would flatten O(width). */
  textIsRope: boolean
  /** Once a row takes an in-place edit it stays on cells for the rest of the chunk. */
  cells: string[] | null
  /** Right-trimmed snapshot; null after a content change. */
  snapshot: string | null
  /** Index after the last non-space/tab, or -1 when unknown. */
  contentEnd: number
  /** Lower bound on the all-space prefix, so a repeated erase-to-start is O(1). */
  blankPrefix: number
  completed: boolean
}

/** Characters touched by O(width) row primitives; read by the work-accounting tests. */
export const retainedRowWork = { split: 0, join: 0, trimScan: 0, build: 0 }

export function resetRetainedRowWork(): void {
  retainedRowWork.split = 0
  retainedRowWork.join = 0
  retainedRowWork.trimScan = 0
  retainedRowWork.build = 0
}

export function retainedRow(text: string, completed: boolean): RetainedTerminalRow {
  return {
    text,
    textIsRope: false,
    cells: null,
    snapshot: null,
    contentEnd: -1,
    blankPrefix: 0,
    completed
  }
}

function isTrimmedWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09
}

function lastContentEnd(source: string, start: number, end: number): number {
  for (let index = end - 1; index >= start; index -= 1) {
    if (!isTrimmedWhitespace(source.charCodeAt(index))) {
      return index + 1
    }
  }
  return -1
}

function rowCells(row: RetainedTerminalRow): string[] {
  if (row.cells === null) {
    retainedRowWork.split += row.text.length
    row.cells = row.text.split('')
    row.textIsRope = false
  }
  return row.cells
}

/** Note a content-changing write of [column, runEnd) whose last non-whitespace ends at `written`. */
function noteWrite(
  row: RetainedTerminalRow,
  column: number,
  runEnd: number,
  written: number
): void {
  row.snapshot = null
  row.blankPrefix = Math.min(row.blankPrefix, column)
  const contentEnd = row.contentEnd
  if (contentEnd > runEnd) {
    return
  }
  if (contentEnd === -1) {
    // Unknown content may survive past the run.
    row.contentEnd = runEnd >= rowLength(row) ? written : -1
  } else if (written !== -1) {
    row.contentEnd = written
  } else if (contentEnd > column) {
    row.contentEnd = -1
  }
}

function rowLength(row: RetainedTerminalRow): number {
  return row.cells === null ? row.text.length : row.cells.length
}

/** Write source[start, end) at `column`; identical characters leave the row clean. */
export function writeRetainedRow(
  row: RetainedTerminalRow,
  column: number,
  source: string,
  start: number,
  end: number
): void {
  const runLength = end - start
  if (row.cells === null) {
    const text = row.text
    if (column >= text.length) {
      const gap = column - text.length
      // Why own: the row can outlive this chunk as a tail line, and a long run is a slice of it.
      const run = ownRetainedString(source.slice(start, end))
      row.text = gap > 0 ? `${text}${' '.repeat(gap)}${run}` : `${text}${run}`
      row.textIsRope = row.text.length > runLength
      retainedRowWork.build += gap + runLength
      noteWrite(row, column, column + runLength, writtenEnd(column, source, start, end))
      return
    }
    if (column === 0 && runLength >= text.length) {
      if (!row.textIsRope && !runDiffers(text, 0, source, start, text.length)) {
        if (runLength > text.length) {
          appendIdenticalRemainder(row, source, start + text.length, end)
        }
        return
      }
      const contentEnd = lastContentEnd(source, start, end)
      row.text = ownRetainedString(source.slice(start, end))
      row.textIsRope = false
      retainedRowWork.build += runLength
      row.snapshot = null
      row.blankPrefix = 0
      row.contentEnd = contentEnd === -1 ? 0 : contentEnd - start
      return
    }
    if (!row.textIsRope) {
      const overlap = Math.min(text.length - column, runLength)
      if (!runDiffers(text, column, source, start, overlap)) {
        if (overlap < runLength) {
          appendIdenticalRemainder(row, source, start + overlap, end)
        }
        return
      }
    }
  }
  writeCells(row, rowCells(row), column, source, start, end)
}

function runDiffers(
  text: string,
  column: number,
  source: string,
  start: number,
  length: number
): boolean {
  for (let offset = 0; offset < length; offset += 1) {
    if (text.charCodeAt(column + offset) !== source.charCodeAt(start + offset)) {
      return true
    }
  }
  return false
}

function appendIdenticalRemainder(
  row: RetainedTerminalRow,
  source: string,
  start: number,
  end: number
): void {
  writeRetainedRow(row, row.text.length, source, start, end)
}

function writeCells(
  row: RetainedTerminalRow,
  cells: string[],
  column: number,
  source: string,
  start: number,
  end: number
): void {
  const oldLength = cells.length
  let changed = false
  if (column > oldLength) {
    cells.length = column
    cells.fill(' ', oldLength, column)
    retainedRowWork.build += column - oldLength
    changed = true
  }
  for (let index = start; index < end; index += 1) {
    const cell = column + index - start
    const char = source[index]!
    if (cells[cell] !== char) {
      cells[cell] = char
      changed = true
    }
  }
  if (changed) {
    noteWrite(row, column, column + end - start, writtenEnd(column, source, start, end))
  }
}

function writtenEnd(column: number, source: string, start: number, end: number): number {
  const runEnd = lastContentEnd(source, start, end)
  return runEnd === -1 ? -1 : column + runEnd - start
}

/** CSI K in modes 0/1/2 at `column`; other modes are no-ops. */
export function eraseRetainedRow(row: RetainedTerminalRow, mode: number, column: number): void {
  const length = rowLength(row)
  // Why column 0 clears: "\r ESC[K" before a repaint must not force the row onto cells.
  if (mode === 2 || (mode === 0 && column === 0)) {
    if (length === 0) {
      return
    }
    if (row.cells === null) {
      row.text = ''
      row.textIsRope = false
    } else {
      row.cells.length = 0
    }
    row.snapshot = null
    row.contentEnd = 0
    row.blankPrefix = 0
    return
  }
  if (mode === 0) {
    if (column >= length) {
      return
    }
    // Why cells: a string truncate after an append re-flattens the row, so a spinner that
    // backs up and erases would cost O(width) per frame.
    rowCells(row).length = column
    row.snapshot = null
    row.blankPrefix = Math.min(row.blankPrefix, column)
    if (row.contentEnd > column) {
      row.contentEnd = -1
    }
    return
  }
  if (mode !== 1) {
    return
  }
  const blankCount = Math.min(column + 1, length)
  if (blankCount <= row.blankPrefix) {
    return
  }
  let firstNonBlank = row.blankPrefix
  if (row.cells === null && !row.textIsRope) {
    const text = row.text
    while (firstNonBlank < blankCount && text.charCodeAt(firstNonBlank) === 0x20) {
      firstNonBlank += 1
    }
    if (firstNonBlank === blankCount) {
      row.blankPrefix = blankCount
      return
    }
  }
  const cells = rowCells(row)
  let changed = false
  for (let index = firstNonBlank; index < blankCount; index += 1) {
    if (cells[index] !== ' ') {
      cells[index] = ' '
      changed = true
    }
  }
  row.blankPrefix = blankCount
  if (!changed) {
    return
  }
  row.snapshot = null
  if (row.contentEnd !== -1 && row.contentEnd <= blankCount) {
    row.contentEnd = 0
  }
}

/** The right-trimmed row text; rebuilt only after a content change. */
export function retainedRowSnapshot(row: RetainedTerminalRow): string {
  if (row.snapshot !== null) {
    return row.snapshot
  }
  const cells = row.cells
  if (row.contentEnd === -1) {
    let end = rowLength(row)
    if (cells === null) {
      const text = row.text
      while (end > 0 && isTrimmedWhitespace(text.charCodeAt(end - 1))) {
        end -= 1
      }
    } else {
      while (end > 0 && isTrimmedWhitespace(cells[end - 1]!.charCodeAt(0))) {
        end -= 1
      }
    }
    retainedRowWork.trimScan += rowLength(row) - end + 1
    row.contentEnd = end
  }
  const end = row.contentEnd
  if (cells !== null) {
    retainedRowWork.join += end
    row.snapshot = end === cells.length ? cells.join('') : cells.slice(0, end).join('')
  } else {
    const text = row.text
    if (row.textIsRope) {
      // Reading a concatenation flattens it once.
      retainedRowWork.join += text.length
      row.textIsRope = false
    }
    row.snapshot = end === text.length ? text : text.slice(0, end)
  }
  return row.snapshot
}
