import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type { TerminalSideEffectBatch } from '../../../shared/terminal-side-effect-facts'
import { toMirroredPaneKey } from './web-session-tabs-sync/agent-status-primitives'

/** A host pane key (`hostTabId:leafId`) as this client's key for the same mirrored pane. */
export function toMirroredHostPaneKey(hostPaneKey: string): string | null {
  const parsed = parsePaneKey(hostPaneKey)
  // Why the status rows' own rule: a fact and its pane's row must name the pane alike.
  return parsed ? toMirroredPaneKey({ parentTabId: parsed.tabId, leafId: parsed.leafId }) : null
}

/** A remote host's batch in this client's ids. The host attributes it to host tabs; this client
 *  keys the same panes by their mirrors, as it does the host's status rows. */
export function toClientTerminalSideEffectBatch(
  batch: TerminalSideEffectBatch,
  environmentId: string
): TerminalSideEffectBatch {
  const { paneKey, tabId, ...rest } = batch
  const mirroredPaneKey = paneKey ? toMirroredHostPaneKey(paneKey) : null
  return {
    ...rest,
    ptyId: toRemoteRuntimePtyId(batch.ptyId, environmentId),
    ...(mirroredPaneKey ? { paneKey: mirroredPaneKey } : {}),
    ...(tabId ? { tabId: toWebTerminalSurfaceTabId(tabId) } : {})
  }
}
