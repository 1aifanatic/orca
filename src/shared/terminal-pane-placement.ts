import { z } from 'zod'
import { TerminalPaneLayoutNodeSchema } from './rpc-contract/session-tabs-schemas-params'
import { isTerminalLeafId } from './stable-pane-id'
import type { TuiAgent } from './tui-agent'
import { isTuiAgent } from './tui-agent-config'

const label = z.string().max(1024)

const NewTabPlacement = z.object({
  kind: z.literal('new-tab'),
  // The tab row the spawn's tab would be created with; TerminalTab field names.
  row: z.object({
    title: label.optional(),
    customTitle: label.nullable().optional(),
    color: label.nullable().optional(),
    startupCwd: z.string().max(4096).optional(),
    shellOverride: label.optional(),
    quickCommandLabel: label.nullable().optional(),
    launchAgent: z.custom<TuiAgent>(isTuiAgent).optional(),
    viewMode: z.enum(['terminal', 'chat']).optional(),
    createdAt: z.number().finite()
  }),
  size: z.object({
    cols: z.number().int().positive().max(10_000),
    rows: z.number().int().positive().max(10_000)
  })
})

const SplitPlacement = z.object({
  kind: z.literal('split'),
  parentLeafId: z.string().refine((value): boolean => isTerminalLeafId(value)),
  direction: z.enum(['horizontal', 'vertical']),
  ratio: z.number().min(0).max(1).optional(),
  // The sender's post-split tree; it can say before/after, which parent + direction cannot.
  proposedRoot: TerminalPaneLayoutNodeSchema.optional()
})

// An existing tab whose layout is still empty.
const RootPlacement = z.object({ kind: z.literal('root') })

const TerminalPanePlacementSchema = z.discriminatedUnion('kind', [
  NewTabPlacement,
  SplitPlacement,
  RootPlacement
])

/** Which tab and leaf a new PTY joins; a binding reads it only for a leaf it does not know yet. */
export type TerminalPanePlacement = z.infer<typeof TerminalPanePlacementSchema>

/** Null for anything malformed, including a kind this build does not know. */
export function parseTerminalPanePlacement(value: unknown): TerminalPanePlacement | null {
  const parsed = TerminalPanePlacementSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
