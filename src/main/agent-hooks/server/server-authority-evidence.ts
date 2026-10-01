import { createHash } from 'node:crypto'

import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type {
  AgentHookAuthorityAttestation,
  AgentHookAuthorityEvidence,
  EnrichedAgentHookEventPayload
} from './server-types'
import { AgentHookServerStatusRetries } from './server-status-retries'

/** What the runtime holds for a pane's PTY: the hash of the launch token it still honours, or null
 *  once that authority ended. Null overall when the runtime has no PTY for the pane. */
export type PaneLaunchAuthorityReader = (
  paneKey: string
) => { launchTokenHash: string | null } | null

export abstract class AgentHookServerAuthorityEvidence extends AgentHookServerStatusRetries {
  private paneLaunchAuthorityReader: PaneLaunchAuthorityReader | null = null

  setPaneLaunchAuthorityReader(reader: PaneLaunchAuthorityReader | null): void {
    this.paneLaunchAuthorityReader = reader
  }

  protected withLiveLaunchToken<T extends { paneKey: string; launchToken?: string }>(event: T): T {
    const launchToken = this.liveLaunchToken(event.paneKey, event.launchToken)
    return launchToken === event.launchToken ? event : { ...event, launchToken }
  }

  /** The event's launch token, or undefined once its authority ended. Every process a shell starts
   *  inherits the token, so after a command end it proves nothing; a token is honoured while the
   *  runtime still holds it for the pane or a commitment of this host still vouches for it.
   *  Derived from that state, never stored: a pane the runtime does not know keeps today's rule. */
  protected liveLaunchToken(paneKey: string, launchToken: string | undefined): string | undefined {
    const token = launchToken?.trim()
    const runtime = token ? this.paneLaunchAuthorityReader?.(paneKey) : null
    if (!token || !runtime) {
      return launchToken
    }
    const launchTokenHash = createHash('sha256').update(token).digest('hex')
    const ownerPaneKey = this.resolvePaneKeyAlias(paneKey)
    return runtime.launchTokenHash === launchTokenHash ||
      this.persistedAuthorityCommitmentsByPaneKey.get(ownerPaneKey)?.launchTokenHash ===
        launchTokenHash ||
      this.hydratedLaunchTokenHashByPaneKey.get(ownerPaneKey) === launchTokenHash
      ? launchToken
      : undefined
  }

  attestCompatibilityAuthority(candidate: {
    paneKey: string
    launchTokenHash: string
    connectionId: string | null
    terminalProvenance: 'current_runtime' | 'restored'
  }): AgentHookAuthorityAttestation | null {
    const paneKey = this.resolvePaneKeyAlias(candidate.paneKey)
    const matchesCandidate = (entry: AgentHookAuthorityEvidence): boolean =>
      entry.launchTokenHash === candidate.launchTokenHash &&
      entry.connectionId === candidate.connectionId
    const commitments = this.hydratedAuthorityCommitments.filter(
      (entry) => matchesCandidate(entry) && !this.revokedHydratedAuthorityCommitments.has(entry)
    )
    const current = Array.from(this.currentAuthorityObservations.values())
    const observations = current.filter(matchesCandidate)
    const paneObservations = current.filter(
      (entry) => this.resolvePaneKeyAlias(entry.paneKey) === paneKey
    )
    const hasUniqueCurrentObservation =
      observations.length === 1 &&
      paneObservations.length === 1 &&
      this.resolvePaneKeyAlias(observations[0]!.paneKey) === paneKey
    if (candidate.terminalProvenance === 'current_runtime') {
      return hasUniqueCurrentObservation ? Object.freeze({ paneKey, source: 'current_hook' }) : null
    }
    if (commitments.length !== 1 || this.resolvePaneKeyAlias(commitments[0]!.paneKey) !== paneKey) {
      return null
    }
    if (observations.length === 0 && paneObservations.length === 0) {
      return Object.freeze({ paneKey, source: 'hydrated_commitment' })
    }
    if (!hasUniqueCurrentObservation) {
      return null
    }
    return Object.freeze({ paneKey, source: 'current_hook' })
  }

  protected captureHydratedAuthorityCommitments(): void {
    this.revokedHydratedAuthorityCommitments = new WeakSet()
    for (const entry of this.state.lastStatusByPaneKey.values()) {
      const evidence = this.toAuthorityEvidence(
        entry as EnrichedAgentHookEventPayload,
        this.hydratedLaunchTokenHashByPaneKey.get(entry.paneKey)
      )
      if (evidence && !this.persistedAuthorityCommitmentsByPaneKey.has(entry.paneKey)) {
        this.persistedAuthorityCommitmentsByPaneKey.set(entry.paneKey, evidence)
      }
    }
    this.hydratedAuthorityCommitments = Object.freeze(
      Array.from(this.persistedAuthorityCommitmentsByPaneKey.values())
    )
  }

  protected recordCurrentAuthorityObservation(payload: AgentHookEventPayload): void {
    const evidence = this.toAuthorityEvidence(payload)
    if (evidence) {
      this.currentAuthorityObservations.set(evidence.paneKey, evidence)
      this.persistedAuthorityCommitmentsByPaneKey.set(evidence.paneKey, evidence)
      this.hydratedLaunchTokenHashByPaneKey.set(evidence.paneKey, evidence.launchTokenHash)
    }
  }

  protected toAuthorityEvidence(
    payload: AgentHookEventPayload | EnrichedAgentHookEventPayload,
    launchTokenHashOverride?: string
  ): AgentHookAuthorityEvidence | null {
    const launchToken = payload.launchToken?.trim()
    const launchTokenHash =
      launchTokenHashOverride ??
      (launchToken ? createHash('sha256').update(launchToken).digest('hex') : null)
    if (!launchTokenHash) {
      return null
    }
    return Object.freeze({
      paneKey: payload.paneKey,
      launchTokenHash,
      connectionId: payload.connectionId,
      ...(payload.tabId ? { tabId: payload.tabId } : {}),
      ...(payload.worktreeId ? { worktreeId: payload.worktreeId } : {}),
      observedAt: 'receivedAt' in payload ? payload.receivedAt : Date.now()
    })
  }
}
