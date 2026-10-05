import type { TerminalLeafMoveRequest } from '../../../shared/terminal-leaf-move'
import type { TerminalLeafMoveOrigin } from './terminal-leaf-move'

const MOVE_ORIGIN_LIMIT = 32

/** Origins of recent moves, held only until the renderer applies the move or asks to undo it. */
export class TerminalLeafMoveOriginLedger {
  private readonly originsByMove = new Map<string, TerminalLeafMoveOrigin[]>()

  remember(request: TerminalLeafMoveRequest, origins: TerminalLeafMoveOrigin[]): void {
    const key = moveKey(request)
    this.originsByMove.delete(key)
    this.originsByMove.set(key, origins)
    // Why bounded: an applied move never asks back, so its entry would otherwise live forever.
    for (const oldest of this.originsByMove.keys()) {
      if (this.originsByMove.size <= MOVE_ORIGIN_LIMIT) {
        break
      }
      this.originsByMove.delete(oldest)
    }
  }

  take(request: TerminalLeafMoveRequest): TerminalLeafMoveOrigin[] {
    const key = moveKey(request)
    const origins = this.originsByMove.get(key) ?? []
    this.originsByMove.delete(key)
    return origins
  }
}

function moveKey(request: TerminalLeafMoveRequest): string {
  return JSON.stringify([
    request.worktreeId,
    request.sourceTabId,
    request.targetTabId,
    request.leafId
  ])
}
