import { z } from 'zod'
import { terminalPaneLayoutNodeSchema } from './workspace-session-schema'

const TerminalLayoutSetRequestSchema = z.object({
  worktreeId: z.string().min(1).max(512),
  tabId: z.string().min(1).max(512),
  root: terminalPaneLayoutNodeSchema
})

/** A user's geometry edit to one tab: divider positions, split directions or pane order, same panes. */
export type TerminalLayoutSetRequest = z.infer<typeof TerminalLayoutSetRequestSchema>

export type TerminalLayoutSetResult =
  | { status: 'committed' }
  | {
      status: 'refused'
      reason: 'invalid_request' | 'home_unresolved' | 'tab_not_held' | 'leaves_differ'
    }

/** Null for anything malformed. */
export function parseTerminalLayoutSetRequest(value: unknown): TerminalLayoutSetRequest | null {
  const parsed = TerminalLayoutSetRequestSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
