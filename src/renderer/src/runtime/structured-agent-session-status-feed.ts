// One host status stream per runtime target, shared by every session-list projection.
//
// The feed is a read-only mirror: the host projects each session's status from its journal and
// this owner keeps the latest summary per session while anyone is looking. Losing the stream
// keeps the cached summaries and reconnects; a fresh snapshot merges over them.
// Which sessions are listed is the tab map's decision, so the feed never retracts a summary.

import type { AgentSessionStatusEvent } from '../../../shared/agent-session-wire'
import {
  foldAgentSessionStatusEvent,
  revokeAgentSessionStatusLive,
  type AgentSessionStatusSnapshot
} from '../../../shared/agent-session-status-snapshot-fold'
import { AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import {
  runtimeEnvironmentSupportsCapability,
  type RuntimeClientTarget
} from './runtime-rpc-client'
import { subscribeStructuredAgentSessionStatus } from './structured-agent-session-client'
import type { StructuredAgentSessionHostCapabilityState } from './structured-agent-session-host-capability'
import { subscribeRuntimeHostContactRegained } from './runtime-host-contact-regained'

export type StructuredAgentSessionStatusSnapshot = AgentSessionStatusSnapshot

export type StructuredAgentSessionStatusFeedOwner = {
  activate: () => () => void
  getSnapshot: () => StructuredAgentSessionStatusSnapshot
  getSessionObservation: (sessionId: string) => 'live' | 'unverifiable'
  getCapability: () => StructuredAgentSessionHostCapabilityState
  subscribe: (listener: () => void) => () => void
}

const RECONNECT_MAX_DELAY_MS = 5_000

/** `stop` is the map's own teardown, not part of the owner contract callers hold. */
type OwnedStatusFeed = StructuredAgentSessionStatusFeedOwner & { stop: () => void }

const owners = new Map<string, OwnedStatusFeed>()

export function structuredAgentSessionStatusFeedKey(target: RuntimeClientTarget): string {
  return target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
}

function createOwner(target: RuntimeClientTarget): OwnedStatusFeed {
  let snapshot: StructuredAgentSessionStatusSnapshot = new Map()
  const confirmedSessions = new Set<string>()
  const listeners = new Set<() => void>()
  const activations = new Set<symbol>()
  let generation = 0
  let handle: { unsubscribe: () => void } | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempt = 0
  let capability: StructuredAgentSessionHostCapabilityState = 'unknown'
  let stopContact: (() => void) | null = null

  const emit = (): void => {
    for (const listener of listeners) {
      listener()
    }
  }
  const setCapability = (next: StructuredAgentSessionHostCapabilityState): void => {
    if (capability !== next) {
      capability = next
      emit()
    }
  }
  const setSnapshot = (next: StructuredAgentSessionStatusSnapshot): void => {
    snapshot = next
    emit()
  }
  const applyEvent = (event: AgentSessionStatusEvent): void => {
    if (event.type === 'snapshot') {
      reconnectAttempt = 0
      for (const session of event.sessions) {
        confirmedSessions.add(session.sessionId)
      }
    } else if (event.type === 'status') {
      confirmedSessions.add(event.session.sessionId)
    } else {
      return
    }
    setSnapshot(foldAgentSessionStatusEvent(snapshot, event))
  }
  const active = (candidate: number): boolean => activations.size > 0 && candidate === generation
  const clearReconnect = (): void => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }
  const dropHandle = (): void => {
    handle?.unsubscribe()
    handle = null
  }
  const revokeSnapshotOwnership = (): void => {
    const next = revokeAgentSessionStatusLive(snapshot)
    if (next !== snapshot) {
      setSnapshot(next)
    }
  }
  let open = (): void => {}
  const scheduleReconnect = (candidate: number): void => {
    if (!active(candidate) || reconnectTimer) {
      return
    }
    const delay = Math.min(250 * 2 ** reconnectAttempt, RECONNECT_MAX_DELAY_MS)
    reconnectAttempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (active(candidate)) {
        open()
      }
    }, delay)
  }
  // Losing contact is never exit: the sessions go unverifiable and this client stops
  // claiming host-owned execution, but nothing here settles them.
  const loseConnection = (candidate: number): void => {
    if (!active(candidate)) {
      return
    }
    generation += 1
    capability = 'unknown'
    confirmedSessions.clear()
    revokeSnapshotOwnership()
    emit()
    clearReconnect()
    dropHandle()
    scheduleReconnect(generation)
  }
  const subscribeToHost = (candidate: number): void => {
    void subscribeStructuredAgentSessionStatus(
      target,
      (event) => {
        if (!active(candidate)) {
          return
        }
        if (event.type === 'end') {
          loseConnection(candidate)
          return
        }
        applyEvent(event)
      },
      () => {
        if (active(candidate)) {
          loseConnection(candidate)
        }
      },
      () => {
        if (active(candidate)) {
          loseConnection(candidate)
        }
      }
    )
      .then((opened) => {
        if (active(candidate)) {
          handle = opened
        } else {
          opened.unsubscribe()
        }
      })
      .catch(() => loseConnection(candidate))
  }
  open = (): void => {
    const candidate = ++generation
    setCapability('unknown')
    dropHandle()
    if (target.kind !== 'environment') {
      // A local host is this build; only a remote one can predate the method.
      setCapability('supported')
      subscribeToHost(candidate)
      return
    }
    const environmentId = target.environmentId
    void runtimeEnvironmentSupportsCapability(
      environmentId,
      AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY
    )
      .then((supported) => {
        if (!active(candidate)) {
          return
        }
        // A host without the method is terminal, not a fault: retrying would relay-probe
        // forever. A failed probe is not an answer, so that path still reconnects.
        if (supported) {
          setCapability('supported')
          subscribeToHost(candidate)
          return
        }
        setCapability('unsupported')
        console.warn('[structured-session-status] host too old for the status feed', environmentId)
      })
      .catch(() => loseConnection(candidate))
  }
  const stop = (): void => {
    generation += 1
    capability = 'unknown'
    stopContact?.()
    stopContact = null
    clearReconnect()
    dropHandle()
    revokeSnapshotOwnership()
    reconnectAttempt = 0
    // Teardown only runs once nothing is activated, so re-confirmation is the next
    // subscribe's job and there is no mounted reader left to notify.
    confirmedSessions.clear()
  }

  return {
    activate: () => {
      const token = Symbol('status-feed')
      activations.add(token)
      if (activations.size === 1) {
        if (target.kind === 'environment') {
          stopContact = subscribeRuntimeHostContactRegained(target.environmentId, () =>
            loseConnection(generation)
          )
        }
        open()
      }
      return () => {
        activations.delete(token)
        if (activations.size === 0) {
          stop()
        }
      }
    },
    getSnapshot: () => snapshot,
    getSessionObservation: (sessionId) =>
      confirmedSessions.has(sessionId) ? 'live' : 'unverifiable',
    getCapability: () => capability,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    stop
  }
}

export function getStructuredAgentSessionStatusFeed(
  target: RuntimeClientTarget
): StructuredAgentSessionStatusFeedOwner {
  const key = structuredAgentSessionStatusFeedKey(target)
  let owner = owners.get(key)
  if (!owner) {
    owner = createOwner(target)
    owners.set(key, owner)
  }
  return owner
}

export function resetStructuredAgentSessionStatusFeedsForTests(): void {
  // Dropping the map alone leaves a live subscription and its pending reconnect running
  // into the next test, where they reopen a stream nothing is holding.
  for (const owner of owners.values()) {
    owner.stop()
  }
  owners.clear()
}
