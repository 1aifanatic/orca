import { z } from 'zod'
import { isTerminalLeafId } from './stable-pane-id'

const id = z.string().min(1).max(512)
const TerminalLeafBindRequestSchema = z.object({
  worktreeId: id,
  tabId: id,
  leafId: id.refine((leafId): boolean => isTerminalLeafId(leafId)),
  ptyId: id
})

/** A live PTY the window adopted onto a pane main already holds. */
export type TerminalLeafBindRequest = z.infer<typeof TerminalLeafBindRequestSchema>

export type TerminalLeafBindResult =
  | { status: 'bound' }
  | { status: 'refused'; reason: 'invalid_request' | 'home_unresolved' | 'not_bound' }

/** Null for anything malformed. */
export function parseTerminalLeafBindRequest(value: unknown): TerminalLeafBindRequest | null {
  const parsed = TerminalLeafBindRequestSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
