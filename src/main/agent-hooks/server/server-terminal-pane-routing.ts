import {
  clearPaneCacheState,
  deleteLegacyAgentStatus,
  paneHasStateClaims
} from '../../../shared/agent-hook-listener/listener-state'
import { AgentHookServerAuthorityFences } from './server-authority-fences'
import { isValidPaneKey } from './server-status-identity'
import type { EnrichedAgentHookEventPayload } from './server-types'

/** Moves state filed under a terminal's exported pane key to the pane it shows now; no alias is minted. */
export abstract class AgentHookServerTerminalPaneRouting extends AgentHookServerAuthorityFences {
  setTerminalPaneResolver(
    resolver: ((paneKey: string, connectionId?: string | null) => string | undefined) | null
  ): void {
    this.terminalPaneResolver = resolver
  }

  reconcileMovedTerminalPaneKeys(envPaneKeys: readonly string[]): void {
    for (const fromPaneKey of envPaneKeys) {
      if (!isValidPaneKey(fromPaneKey) || !this.holdsPaneAuthorityState(fromPaneKey)) {
        continue
      }
      const toPaneKey = this.terminalPaneResolver?.(fromPaneKey)
      if (
        !toPaneKey ||
        toPaneKey === fromPaneKey ||
        !isValidPaneKey(toPaneKey) ||
        this.isClosedAgentStatusTabForPaneKey(toPaneKey)
      ) {
        continue
      }
      this.takeRetiredPaneRestartId(fromPaneKey)
      this.takeRetiredPaneRestartId(toPaneKey)
      const fromRow = this.statusRow(fromPaneKey)
      const toRow = this.statusRow(toPaneKey)
      if (toRow && (!fromRow || fromRow.receivedAt <= toRow.receivedAt)) {
        this.retireSupersededPaneKey(fromPaneKey, toPaneKey)
        continue
      }
      if (toRow) {
        // The exported key's row is newer: the pane's own older row yields to it.
        deleteLegacyAgentStatus(this.state, toPaneKey)
        this.commitStatusRowMutation(toRow, undefined)
      }
      this.commitMovedPaneAuthorityState(this.movePaneAuthorityState(fromPaneKey, toPaneKey), true)
    }
  }

  // Raw key, never through an alias; launch authority the pane lacks is kept so later posts verify.
  private retireSupersededPaneKey(fromPaneKey: string, toPaneKey: string): void {
    const row = this.statusRow(fromPaneKey)
    const tokenHash = this.hydratedLaunchTokenHashByPaneKey.get(fromPaneKey)
    if (tokenHash && !this.hydratedLaunchTokenHashByPaneKey.has(toPaneKey)) {
      this.hydratedLaunchTokenHashByPaneKey.set(toPaneKey, tokenHash)
    }
    const commitment = this.persistedAuthorityCommitmentsByPaneKey.get(fromPaneKey)
    if (commitment && !this.persistedAuthorityCommitmentsByPaneKey.has(toPaneKey)) {
      this.persistedAuthorityCommitmentsByPaneKey.set(
        toPaneKey,
        Object.freeze({ ...commitment, paneKey: toPaneKey })
      )
    }
    this.hydratedLaunchTokenHashByPaneKey.delete(fromPaneKey)
    this.persistedAuthorityCommitmentsByPaneKey.delete(fromPaneKey)
    this.clearAssistantMessageRetry(fromPaneKey)
    this.clearTranscriptPoll(fromPaneKey)
    clearPaneCacheState(this.state, fromPaneKey)
    this.activeHookTurnCompletedAtByPaneKey.delete(fromPaneKey)
    this.runtimeObservedStatusPaneKeys.delete(fromPaneKey)
    this.currentAuthorityObservations.delete(fromPaneKey)
    this.promptSentDedupeByPaneKey.delete(fromPaneKey)
    this.evidenceObservedAtByPaneKey.delete(fromPaneKey)
    if (row) {
      this.commitStatusRowMutation(row, undefined)
      this.emitPaneStatusCleared({ paneKey: fromPaneKey })
    }
    this.scheduleStatusPersist()
    this.notifyStatusChangeListeners()
  }

  private statusRow(paneKey: string): EnrichedAgentHookEventPayload | undefined {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every row in this store is written through applyNormalizedStatus or hydration, which stamp the enriched fields.
    return this.state.lastStatusByPaneKey.get(paneKey) as EnrichedAgentHookEventPayload | undefined
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
