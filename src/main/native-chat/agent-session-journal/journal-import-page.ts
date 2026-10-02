// How many rows each task of a per-chat file's copy reads and writes. A whole page where a task is
// cheap (one 512-row commit, as few checkpoints as the copy can have), fewer where a slow disk or
// CPU makes one run long: each task's wall time, from the end of one yield to the start of the
// next, sets the next page. The char ceilings still split a page of huge rows.

import { setImmediate as yieldToEventLoop } from 'node:timers/promises'

/** A task's wall-time target: past it the next page halves; after two tasks in a row under half
 *  of it (a page's read and its write), it grows a quarter. */
export const IMPORT_TASK_TARGET_MS = 25
/** The fewest rows a page shrinks to. */
export const IMPORT_MIN_PAGE_ROWS = 8

export class JournalImportPage {
  /** Rows the next read takes. */
  rows: number
  private readonly minRows: number
  private taskStart: number
  private fastTasks = 0

  constructor(
    private readonly maxRows: number,
    private readonly yieldToNext: () => Promise<void> = () => yieldToEventLoop(),
    private readonly clock: () => number = () => performance.now()
  ) {
    this.rows = maxRows
    this.minRows = Math.min(IMPORT_MIN_PAGE_ROWS, maxRows)
    this.taskStart = clock()
  }

  /** Ends the task in hand; the next page follows how long it took. */
  yieldTask = async (): Promise<void> => {
    const took = this.clock() - this.taskStart
    this.fastTasks = took < IMPORT_TASK_TARGET_MS / 2 ? this.fastTasks + 1 : 0
    if (took > IMPORT_TASK_TARGET_MS) {
      this.rows = Math.max(this.minRows, Math.floor(this.rows / 2))
    } else if (this.fastTasks === 2) {
      this.fastTasks = 0
      this.rows = Math.min(this.maxRows, Math.ceil(this.rows * 1.25))
    }
    await this.yieldToNext()
    this.taskStart = this.clock()
  }
}
