import { iterateTerminalInputChunks } from '../../shared/terminal-input'

export const PTY_INPUT_WRITE_ALLOWANCE_MS = 100
export const PTY_INPUT_HOLD_MARGIN_MS = 1_000

export type PtyInputHold = { writeCount: number; delayMs?: number }

export function countPtyInputChunkWrites(text: string): number {
  let count = 0
  for (const _chunk of iterateTerminalInputChunks(text)) {
    count++
  }
  return Math.max(1, count)
}

export function resolvePtyInputHoldMs(hold: PtyInputHold = { writeCount: 1 }): number {
  const delayMs = hold.delayMs ?? 0
  if (!Number.isFinite(hold.writeCount) || !Number.isFinite(delayMs)) {
    throw new Error('invalid_input_hold')
  }
  return (
    Math.max(1, hold.writeCount) * PTY_INPUT_WRITE_ALLOWANCE_MS +
    Math.max(0, delayMs) +
    PTY_INPUT_HOLD_MARGIN_MS
  )
}
