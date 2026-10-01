import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import { makePaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type { TerminalSideEffectBatch } from '../../../shared/terminal-side-effect-facts'

/** A host pane key (`hostTabId:leafId`) as this client's key for the same mirrored pane. */
export function toMirroredHostPaneKey(hostPaneKey: string): string | null {
  const parsed = parsePaneKey(hostPaneKey)
  return parsed ? makePaneKey(toWebTerminalSurfaceTabId(parsed.tabId), parsed.leafId) : null
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
