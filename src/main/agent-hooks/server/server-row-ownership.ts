import {
  isWslHookRelayConnectionId,
  wslHookRelayConnectionId
} from '../../../shared/wsl-hook-relay-contract'
import { splitWorktreeIdForFilesystem, worktreeIdsEqual } from '../../../shared/worktree/id'
import { parseWslUncPath } from '../../../shared/wsl-paths'
import { structuralValuesEqualIgnoringUndefined } from '../../../shared/structural-value-equality'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import {
  isSameAgentProcess,
  type AgentPaneOwner,
  type AgentProcessPresence
} from '../../../shared/agent-process-presence'
import type {
  AgentHookStatusRowIdentity,
  AgentHookStatusRowMutation,
  AgentOwnerListener,
  EnrichedAgentHookEventPayload,
  StatusRowMutationListener
} from './server-types'
import { toAgentStatusIpcPayload } from './server-status-identity'
import { AgentHookServerListeners } from './server-listeners'

function toMutationIdentity(
  row: EnrichedAgentHookEventPayload | null | undefined
): AgentHookStatusRowIdentity | null {
  if (!row) {
    return null
  }
  return {
    paneKey: row.paneKey,
    ...(row.worktreeId ? { worktreeId: row.worktreeId } : {}),
    ...(row.terminalHandle ? { terminalHandle: row.terminalHandle } : {})
  }
}

function semanticRow(row: EnrichedAgentHookEventPayload): Record<string, unknown> {
  const {
    receivedAt: _receivedAt,
    evidenceObservedAt: _evidenceObservedAt,
    observation: _observation,
    launchToken: _launchToken,
    promptInteractionKey: _promptInteractionKey,
    ...semantic
  } = toAgentStatusIpcPayload(row)
  return semantic
}

// Why: runs on every status write; a structural walk exits on the first difference and skips
// shared leaves (e.g. an unchanged 8 KB lastAssistantMessage) instead of serializing both rows.
function semanticRowsEqual(
  before: EnrichedAgentHookEventPayload | null | undefined,
  after: EnrichedAgentHookEventPayload | null | undefined
): boolean {
  if (before === after || (!before && !after)) {
    return true
  }
  if (!before || !after) {
    return false
  }
  return structuralValuesEqualIgnoringUndefined(semanticRow(before), semanticRow(after))
}

function wslDistroForWorktree(worktreeId: string | undefined): string | null {
  const worktreePath = worktreeId
    ? splitWorktreeIdForFilesystem(worktreeId)?.worktreePath
    : undefined
  return worktreePath ? (parseWslUncPath(worktreePath)?.distro ?? null) : null
}

function ownerIdentity(owner: AgentPaneOwner | undefined): AgentHookStatusRowIdentity | null {
  return owner
    ? {
        paneKey: owner.paneKey,
        ...(owner.worktreeId ? { worktreeId: owner.worktreeId } : {}),
        ...(owner.terminalHandle ? { terminalHandle: owner.terminalHandle } : {})
      }
    : null
}

function remoteOwnerRecord(
  scope: Pick<AgentHookEventPayload, 'paneKey' | 'connectionId' | 'worktreeId' | 'tabId'>,
  presence: AgentProcessPresence,
  recorded: AgentPaneOwner | undefined
): AgentPaneOwner {
  return {
    paneKey: scope.paneKey,
    connectionId: scope.connectionId,
    ...(scope.worktreeId ? { worktreeId: scope.worktreeId } : {}),
    ...(scope.tabId ? { tabId: scope.tabId } : {}),
    presence,
    receivedAt: Math.max(Date.now(), (recorded?.receivedAt ?? -1) + 1)
  }
}

export abstract class AgentHookServerRowOwnership extends AgentHookServerListeners {
  _resetRowOwnershipForTests(): void {
    this.paneKeyByTerminalHandle.clear()
  }

  subscribeStatusRowMutations(listener: StatusRowMutationListener): () => void {
    this.statusRowMutationListeners.add(listener)
    return () => {
      this.statusRowMutationListeners.delete(listener)
    }
  }

  protected getStatusPaneKeyForTerminalHandle(terminalHandle: string): string | undefined {
    return this.paneKeyByTerminalHandle.get(terminalHandle)
  }

  protected sameTerminalOwner(
    previous: EnrichedAgentHookEventPayload,
    incoming: Pick<AgentHookEventPayload, 'connectionId' | 'worktreeId'>
  ): boolean {
    if (
      previous.worktreeId &&
      incoming.worktreeId &&
      !worktreeIdsEqual(previous.worktreeId, incoming.worktreeId)
    ) {
      return false
    }
    if (previous.connectionId === incoming.connectionId) {
      return true
    }
    const relayConnection = isWslHookRelayConnectionId(previous.connectionId)
      ? previous.connectionId
      : isWslHookRelayConnectionId(incoming.connectionId)
        ? incoming.connectionId
        : null
    const localConnection = previous.connectionId === null || incoming.connectionId === null
    if (!relayConnection || !localConnection || !previous.worktreeId || !incoming.worktreeId) {
      return false
    }
    const previousDistro = wslDistroForWorktree(previous.worktreeId)
    const incomingDistro = wslDistroForWorktree(incoming.worktreeId)
    return (
      previousDistro !== null &&
      incomingDistro !== null &&
      previousDistro === incomingDistro &&
      relayConnection === wslHookRelayConnectionId(previousDistro) &&
      worktreeIdsEqual(previous.worktreeId, incoming.worktreeId)
    )
  }

  /** An owner write recorded a live owner; the owner recheck arms itself from here. */
  protected noteLiveAgentOwner(): void {}

  /** The process that owns the pane, as this host recorded it; never a turn. */
  getAgentOwner(paneKey: string): AgentPaneOwner | undefined {
    return this.agentOwnerByPaneKey.get(this.resolvePaneKeyAlias(paneKey))
  }

  getAgentOwners(): AgentPaneOwner[] {
    return [...this.agentOwnerByPaneKey.values()]
  }

  /** Multi-subscriber tap on owner changes, shaped like a row mutation so republishers reuse it. */
  subscribeAgentOwnerChanges(listener: StatusRowMutationListener): () => void {
    this.agentOwnerChangeListeners.add(listener)
    return () => {
      this.agentOwnerChangeListeners.delete(listener)
    }
  }

  /** Publishes every owner change; replays the current owners to a new listener. */
  setAgentOwnerListener(listener: AgentOwnerListener | null): void {
    this.onAgentOwner = listener
    for (const owner of listener ? this.agentOwnerByPaneKey.values() : []) {
      listener?.(owner)
    }
  }

  /** Owners follow their surface: a closed tab or a closed pane admits none. */
  protected isOwnerFenced(paneKey: string): boolean {
    const resolved = this.resolvePaneKeyAlias(paneKey)
    return (
      this.closedAgentStatusPaneKeys.has(paneKey) ||
      this.closedAgentStatusPaneKeys.has(resolved) ||
      this.isClosedAgentStatusTabForPaneKey(resolved) ||
      this.retiredPaneFencesByKey.get(resolved)?.closed === true
    )
  }

  /** The one owner mutation, so no path can strand a published owner or skip the recheck. */
  protected writeAgentOwner(paneKey: string, next: AgentPaneOwner | undefined): void {
    const before = this.agentOwnerByPaneKey.get(paneKey)
    if (before === next || (!before && !next)) {
      return
    }
    if (next) {
      this.agentOwnerByPaneKey.set(paneKey, next)
    } else {
      this.agentOwnerByPaneKey.delete(paneKey)
    }
    const process = before?.presence.process
    const carried = next?.presence.process
    if (process && !(carried && isSameAgentProcess(carried, process))) {
      this.emitAgentPresenceReleased({ paneKey, process })
    }
    if (next) {
      if (carried && !next.presence.ended) {
        this.noteLiveAgentOwner()
      }
      this.onAgentOwner?.(next)
    }
    const change = { before: ownerIdentity(before), after: ownerIdentity(next) }
    for (const listener of this.agentOwnerChangeListeners) {
      try {
        listener(change)
      } catch (error) {
        console.error('[agent-hooks] owner change listener threw', error)
      }
    }
    this.notifyStatusChangeListeners()
  }

  /** A relay's own host decided this owner; this desktop records it and never re-decides. Returns
   *  true when a different process took the pane, so its predecessor's turn is not inherited. */
  protected applyRemoteOwner(
    scope: Pick<
      AgentHookEventPayload,
      'paneKey' | 'connectionId' | 'worktreeId' | 'tabId' | 'terminalHandle'
    >,
    presence: AgentProcessPresence
  ): boolean {
    const { paneKey } = scope
    const recorded = this.agentOwnerByPaneKey.get(paneKey)
    const process = presence.process
    // Temporary: presence-wsl-guest-binding must bind a guest shell before WSL can own a process.
    if (!process || isWslHookRelayConnectionId(scope.connectionId) || this.isOwnerFenced(paneKey)) {
      return false
    }
    const recordedProcess = recorded?.presence.process
    const same = Boolean(recordedProcess && isSameAgentProcess(recordedProcess, process))
    if (presence.ended) {
      // Why: with no recorded owner there is nothing to order this exit against, so it may be
      // older than a later unidentified turn; otherwise the fence admitted only newer evidence.
      if (!recorded || (same && recorded.presence.ended)) {
        return false
      }
      if (!same) {
        this.writeAgentOwner(paneKey, remoteOwnerRecord(scope, presence, recorded))
      }
      this.reconcileEndedProcessForPaneKeys([paneKey], { kind: 'owner-exited', presence })
      return false
    }
    if (same && recorded && !recorded.presence.ended) {
      // Why: a restated owner advances only the ordering watermark; republishing it is noise.
      this.agentOwnerByPaneKey.set(paneKey, {
        ...recorded,
        presence: { ...recorded.presence, observation: presence.observation }
      })
      return false
    }
    this.writeAgentOwner(paneKey, remoteOwnerRecord(scope, presence, recorded))
    return Boolean(recordedProcess && !same)
  }

  /** Version adapter, removable once the supported relay floor stamps exits on its own host: an
   *  older relay's hook-claimed exit may clear the pane's turn, never mint one, and never end an
   *  owner this side recorded. */
  protected applyLegacyRelayExitClaim(paneKey: string, presence: AgentProcessPresence): void {
    const row = this.state.lastStatusByPaneKey.get(paneKey)
    // Why: the claim names its agent, so it cannot end another agent's turn (a nested run's exit).
    if (row?.payload.agentType !== presence.agent || this.agentOwnerByPaneKey.has(paneKey)) {
      return
    }
    this.reconcileEndedProcessForPaneKeys([paneKey], { kind: 'owner-exited', presence })
  }

  protected commitStatusRowMutation(
    before: EnrichedAgentHookEventPayload | null | undefined,
    after: EnrichedAgentHookEventPayload | null | undefined,
    emit = true
  ): boolean {
    if (
      before?.terminalHandle &&
      this.paneKeyByTerminalHandle.get(before.terminalHandle) === before.paneKey
    ) {
      this.paneKeyByTerminalHandle.delete(before.terminalHandle)
    }
    if (after?.terminalHandle) {
      this.paneKeyByTerminalHandle.set(after.terminalHandle, after.paneKey)
    }
    if (!emit || semanticRowsEqual(before, after)) {
      return false
    }
    const mutation: AgentHookStatusRowMutation = {
      before: toMutationIdentity(before),
      after: toMutationIdentity(after)
    }
    for (const listener of this.statusRowMutationListeners) {
      try {
        listener(mutation)
      } catch (error) {
        console.error('[agent-hooks] status-row mutation listener threw', error)
      }
    }
    return true
  }
}
