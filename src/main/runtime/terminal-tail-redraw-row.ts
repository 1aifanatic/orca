export type RetainedTerminalRow = {
  text: string
  /** Mutable cells once a row takes many edits between snapshots; `text` is stale while set. */
  cells: string[] | null
  /** String edits since the row was last read as text. */
  stringEdits: number
  completed: boolean
}

// Why: a string splice is a cheap flat copy, so a few edits per snapshot stay on strings; past this
// many, per-edit copies of a wide row would go O(width x edits), so the row switches to cells.
const MAX_STRING_EDITS_PER_SNAPSHOT = 32

export function retainedRow(text: string, completed: boolean): RetainedTerminalRow {
  return { text, cells: null, stringEdits: 0, completed }
}

export function rowCellsForEdit(row: RetainedTerminalRow): string[] | null {
  if (row.cells === null) {
    if (row.stringEdits < MAX_STRING_EDITS_PER_SNAPSHOT) {
      row.stringEdits += 1
      return null
    }
    row.cells = row.text.split('')
  }
  return row.cells
}

// Why join only edited cells and then drop them: re-joining an unchanged wide row on every
// cursor-up/newline revisit cost O(width) per newline and froze main for seconds.
export function retainedRowText(row: RetainedTerminalRow): string {
  if (row.cells !== null) {
    row.text = row.cells.join('')
    row.cells = null
  }
  row.stringEdits = 0
  return row.text
}
