import { paneHasStateClaims } from '../../../shared/agent-hook-listener/listener-state'
import { AgentHookServerAuthorityFences } from './server-authority-fences'
import { isValidPaneKey } from './server-status-identity'

/**
 * Status follows the terminal, not the pane key its environment was spawned with. The execution
 * host answers "which pane shows the live terminal that exported this key"; ingress files posts
 * there, and this layer moves anything already filed under the exported key. No alias is minted:
 * the host derives the answer from its own process record, which dies with the process.
 */
export abstract class AgentHookServerTerminalPaneRouting extends AgentHookServerAuthorityFences {
  setTerminalPaneResolver(resolver: ((paneKey: string) => string | undefined) | null): void {
    this.terminalPaneResolver = resolver
  }

  /** Moves rows and authority filed under each exported key to the pane its terminal shows now. */
  reconcileMovedTerminalPaneKeys(envPaneKeys: readonly string[]): void {
    for (const fromPaneKey of envPaneKeys) {
      const toPaneKey = this.terminalPaneResolver?.(fromPaneKey)
      if (
        !toPaneKey ||
        toPaneKey === fromPaneKey ||
        !isValidPaneKey(fromPaneKey) ||
        !isValidPaneKey(toPaneKey) ||
        this.isClosedAgentStatusTabForPaneKey(toPaneKey) ||
        !this.holdsPaneAuthorityState(fromPaneKey)
      ) {
        continue
      }
      if (this.state.lastStatusByPaneKey.has(toPaneKey)) {
        // The live pane already reports for itself; the exported key's row predates the move.
        this.clearPaneState(fromPaneKey)
        continue
      }
      this.commitMovedPaneAuthorityState(this.movePaneAuthorityState(fromPaneKey, toPaneKey), true)
    }
  }

  private holdsPaneAuthorityState(paneKey: string): boolean {
    return (
      paneHasStateClaims(this.state, paneKey) ||
      this.hydratedLaunchTokenHashByPaneKey.has(paneKey) ||
      this.persistedAuthorityCommitmentsByPaneKey.has(paneKey) ||
      this.currentAuthorityObservations.has(paneKey)
    )
  }
}
