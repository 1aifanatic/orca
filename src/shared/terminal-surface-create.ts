import { z } from 'zod'
import { isTerminalLeafId } from './stable-pane-id'
import { TerminalPanePlacementSchema } from './terminal-pane-placement'

const id = z.string().min(1).max(512)
const TerminalSurfaceCreateRequestSchema = z.object({
  worktreeId: id,
  tabId: id,
  /** Absent for a tab created before its first pane exists. */
  leafId: id.refine((leafId): boolean => isTerminalLeafId(leafId)).optional(),
  placement: TerminalPanePlacementSchema
})

/** A tab or pane the window created, recorded unbound in main before any process starts. */
export type TerminalSurfaceCreateRequest = z.infer<typeof TerminalSurfaceCreateRequestSchema>

export type TerminalSurfaceCreateResult =
  | { status: 'committed' }
  | {
      status: 'refused'
      reason: 'invalid_request' | 'home_unresolved' | 'tab_not_held' | 'parent_missing'
    }

/** Null for anything malformed. */
export function parseTerminalSurfaceCreateRequest(
  value: unknown
): TerminalSurfaceCreateRequest | null {
  const parsed = TerminalSurfaceCreateRequestSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
