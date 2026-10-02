import {
  clearPaneCacheState,
  paneHasStateClaims
} from '../../../shared/agent-hook-listener/listener-state'
import { AgentHookServerAuthorityFences } from './server-authority-fences'
import { isValidPaneKey } from './server-status-identity'
import type { EnrichedAgentHookEventPayload } from './server-types'

export type TerminalPaneMove = {
  fromPaneKey: string
  toPaneKey: string
  /** The host that runs the terminal; rows from any other host are never moved. */
  connectionId: string | null
}

/** Moves state filed under a terminal's exported pane key to the pane it shows now; no alias is minted. */
export abstract class AgentHookServerTerminalPaneRouting extends AgentHookServerAuthorityFences {
  setTerminalPaneResolver(
    resolver: ((paneKey: string, connectionId?: string | null) => string | undefined) | null
  ): void {
    this.terminalPaneResolver = resolver
  }

  reconcileMovedTerminalPaneKeys(moves: readonly TerminalPaneMove[]): void {
    for (const { fromPaneKey, toPaneKey, connectionId } of moves) {
      const fromRow = this.statusRow(fromPaneKey)
      if (
        fromPaneKey === toPaneKey ||
        !isValidPaneKey(fromPaneKey) ||
        !isValidPaneKey(toPaneKey) ||
        !this.holdsPaneAuthorityState(fromPaneKey) ||
        (fromRow !== undefined && (fromRow.connectionId ?? null) !== connectionId) ||
        this.isClosedAgentStatusTabForPaneKey(toPaneKey)
      ) {
        continue
      }
      this.takeRetiredPaneRestartId(fromPaneKey)
      this.takeRetiredPaneRestartId(toPaneKey)
      this.repointPaneKeyAliases(fromPaneKey, toPaneKey)
      const toRow = this.statusRow(toPaneKey)
      if (toRow && (!fromRow || fromRow.receivedAt <= toRow.receivedAt)) {
        this.carryLaunchAuthority(fromPaneKey, toPaneKey)
        this.clearRawPaneState(fromPaneKey)
        continue
      }
      if (toRow) {
        // The exported key's row is newer: the pane's own older state yields to it entirely.
        this.clearRawPaneState(toPaneKey)
      }
      this.commitMovedPaneAuthorityState(this.movePaneAuthorityState(fromPaneKey, toPaneKey), true)
    }
  }

  private repointPaneKeyAliases(fromPaneKey: string, toPaneKey: string): void {
    let changed = false
    for (const [physicalPaneKey, entry] of this.legacyPaneKeyAliases) {
      if (entry.stablePaneKey === fromPaneKey) {
        this.legacyPaneKeyAliases.set(physicalPaneKey, { ...entry, stablePaneKey: toPaneKey })
        changed = true
      }
    }
    if (changed) {
      this.notifyPaneKeyAliasPersistenceListener()
    }
  }

  // Why: the superseded key's process still posts; keep its launch authority where the pane lacks one.
  private carryLaunchAuthority(fromPaneKey: string, toPaneKey: string): void {
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
  }

  // Raw key, never through an alias: an alias owner is a different pane.
  private clearRawPaneState(paneKey: string): void {
    const row = this.statusRow(paneKey)
    this.hydratedLaunchTokenHashByPaneKey.delete(paneKey)
    this.persistedAuthorityCommitmentsByPaneKey.delete(paneKey)
    this.restartedStatusLaunchTokenHashByPaneKey.delete(paneKey)
    this.clearAssistantMessageRetry(paneKey)
    this.clearTranscriptPoll(paneKey)
    clearPaneCacheState(this.state, paneKey)
    this.activeHookTurnCompletedAtByPaneKey.delete(paneKey)
    this.runtimeObservedStatusPaneKeys.delete(paneKey)
    this.currentAuthorityObservations.delete(paneKey)
    this.promptSentDedupeByPaneKey.delete(paneKey)
    this.evidenceObservedAtByPaneKey.delete(paneKey)
    if (row) {
      this.commitStatusRowMutation(row, undefined)
      this.emitPaneStatusCleared({ paneKey })
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
      this.currentAuthorityObservations.has(paneKey) ||
      this.restartedStatusLaunchTokenHashByPaneKey.has(paneKey)
    )
  }
}
