import { getPtyIpc } from '../../pty-host-bindings'
import type { Store } from '../../../persistence'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { agentHookServer } from '../../../agent-hooks/server'
import {
  isTerminalLeafMoveRequest,
  type TerminalLeafMoveRequest,
  type TerminalLeafMoveResult
} from '../../../../shared/terminal-leaf-move'

/** Durable move first; agent-status and orchestration keys follow only a committed move. */
export async function moveTerminalLeafToNewTab(
  deps: { store?: Store; runtime?: OrcaRuntimeService },
  request: TerminalLeafMoveRequest
): Promise<TerminalLeafMoveResult> {
  if (!deps.store) {
    return { status: 'not_held' }
  }
  const result = await deps.store.moveTerminalLeafToNewTab(request)
  if (result.status !== 'moved') {
    return result
  }
  const [fromTabId, toTabId] = request.undo
    ? [request.targetTabId, request.sourceTabId]
    : [request.sourceTabId, request.targetTabId]
  const fromPaneKey = `${fromTabId}:${request.leafId}`
  const toPaneKey = `${toTabId}:${request.leafId}`
  try {
    // The process keeps the pane key baked into its env, so status must alias old to new.
    agentHookServer.transferPaneAuthority(
      fromPaneKey,
      toPaneKey,
      result.ptyId ?? undefined,
      Date.now(),
      {
        authorityVerified: true
      }
    )
  } catch (error) {
    console.warn('[pty] moved pane kept its old agent-status key:', error)
  }
  try {
    deps.runtime?.getExistingOrchestrationDb()?.rekeyWorkerTerminalResourcePaneKey({
      fromPaneKey,
      toPaneKey
    })
  } catch (error) {
    console.warn('[pty] moved pane kept its old orchestration resource key:', error)
  }
  return result
}

export function installPtyLeafMoveIpcHandler(deps: {
  store?: Store
  runtime?: OrcaRuntimeService
}): void {
  getPtyIpc().handle('pty:moveLeafToNewTab', async (_event, args: unknown) => {
    if (!isTerminalLeafMoveRequest(args)) {
      return { status: 'refused', reason: 'invalid_request' } satisfies TerminalLeafMoveResult
    }
    return moveTerminalLeafToNewTab(deps, args)
  })
}
