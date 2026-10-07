import type { TerminalPaneLayoutNode } from '../../../../shared/terminal-tab-types'
import type {
  TerminalTopologyLayout,
  TerminalTopologySlice
} from '../../../../shared/terminal-topology-slice'
import { collectLeafIds } from '@/components/terminal-pane/terminal-pane-layout-tree'
import { omitRecordKeys } from '../slices/worktrees/teardown/record-key-omission'
import type { TerminalSlice, TerminalStoreSet } from './terminal-state'

/** A user's geometry edit main has not published yet; `publishSeq` arrives with main's reply. */
export type TerminalLayoutGesture = { root: TerminalPaneLayoutNode; publishSeq?: number }

const leafSet = (root: TerminalPaneLayoutNode | null): string =>
  collectLeafIds(root).sort().join('\n')

/**
 * Main's layouts with each pending gesture's root kept, so an older push can't snap a divider
 * back. A gesture ends once the slice holds its publishSeq, or once main's tab has other panes
 * (main refuses a gesture that would change them).
 */
export function holdTerminalLayoutGestures(
  gestures: Record<string, TerminalLayoutGesture>,
  slice: TerminalTopologySlice
): {
  layouts: Record<string, TerminalTopologyLayout>
  held: Record<string, TerminalLayoutGesture>
} {
  const layouts = { ...slice.layouts }
  const held: Record<string, TerminalLayoutGesture> = {}
  for (const [tabId, gesture] of Object.entries(gestures)) {
    const layout = slice.layouts[tabId]
    if (
      layout &&
      !(gesture.publishSeq !== undefined && slice.publishSeq >= gesture.publishSeq) &&
      leafSet(layout.root) === leafSet(gesture.root)
    ) {
      layouts[tabId] = { ...layout, root: gesture.root }
      held[tabId] = gesture
    }
  }
  return { layouts, held }
}

export function createTerminalLayoutGestureActions(
  set: TerminalStoreSet
): Pick<TerminalSlice, 'commitTerminalLayoutGesture'> {
  return {
    commitTerminalLayoutGesture: (worktreeId, tabId, root) => {
      // Why optional: an older preload can linger through an in-place renderer reload.
      const send = globalThis.window?.api?.session?.setTerminalLayout
      if (!send) {
        return
      }
      set((s) => ({
        terminalLayoutGesturesByWorktree: {
          ...s.terminalLayoutGesturesByWorktree,
          [worktreeId]: { ...s.terminalLayoutGesturesByWorktree[worktreeId], [tabId]: { root } }
        }
      }))
      const settle = (publishSeq: number | undefined): void =>
        set((s) => {
          const gestures = s.terminalLayoutGesturesByWorktree[worktreeId] ?? {}
          // A later gesture on the tab owns it now.
          if (gestures[tabId]?.root !== root) {
            return s
          }
          const unpublished =
            publishSeq !== undefined &&
            (s.terminalTopologySeqByWorktree[worktreeId] ?? 0) < publishSeq
          return {
            terminalLayoutGesturesByWorktree: {
              ...s.terminalLayoutGesturesByWorktree,
              [worktreeId]: unpublished
                ? { ...gestures, [tabId]: { root, publishSeq } }
                : omitRecordKeys(gestures, [tabId])
            }
          }
        })
      void send({ worktreeId, tabId, root }).then(
        (reply) => settle(reply.publishSeq),
        (error: unknown) => {
          console.warn('[terminal-layout] main did not commit the layout', error)
          settle(undefined)
        }
      )
    }
  }
}
