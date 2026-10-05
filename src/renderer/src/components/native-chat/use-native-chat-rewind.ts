import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ConfirmationDialogContextValue } from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import type {
  AgentSessionRewindReason,
  AgentSessionRewindResult,
  AgentSessionRewindSupport
} from '../../../../shared/agent-session-rewind'
import type { AgentSessionWriteFailure } from '../../../../shared/agent-session-write-failure'
import type { StructuredAgentSessionState } from '../../../../shared/structured-agent-session-reducer'
import {
  nativeChatRewindReasonCopy,
  nativeChatRewindUnavailableCopy
} from './native-chat-rewind-copy'
import type {
  StructuredAgentSessionWrite,
  StructuredAgentSessionWriteOutcome
} from './use-structured-agent-session-mutate'
import { returnMessageToComposer } from './structured-agent-session-withdrawn-message-restore'

export type NativeChatRewindSurface = {
  disabledReason: string | null
  request: (itemId: string, confirm: ConfirmationDialogContextValue) => Promise<void>
}

type RewindInput = {
  sessionId: string
  /** The composer the discarded message returns to, after whatever is typed there. */
  composerScopeKey?: string
  state: StructuredAgentSessionState
  /** Undefined until the host has answered for the current runtime. */
  support: AgentSessionRewindSupport | undefined
  hostBlockedReason?: AgentSessionRewindReason
  blocked: boolean
  send: (fields: {
    itemId: string
    expectedEpoch: string
  }) => Promise<StructuredAgentSessionWriteOutcome<AgentSessionRewindResult>>
}

/** Which rewind check refused; `outcome-unknown` whenever nothing proves the rewind did not run. */
function rewindFailureReason(failure: AgentSessionWriteFailure): string | undefined {
  if (failure.kind === 'unconfirmed') {
    return 'outcome-unknown'
  }
  if (failure.kind === 'failed') {
    return undefined
  }
  if (failure.code === 'agent_session_operation_unknown') {
    return 'outcome-unknown'
  }
  if (failure.code === 'structured_agent_session_unsupported') {
    return 'unsupported'
  }
  return failure.details && 'rewindReason' in failure.details
    ? failure.details.rewindReason
    : undefined
}

export function countNativeChatRewindMessages(
  state: StructuredAgentSessionState,
  itemId: string
): number {
  const index = state.items.findIndex(
    (item) => item.itemId === itemId && item.body.kind === 'message' && item.body.role === 'user'
  )
  return index === -1
    ? 0
    : state.items.slice(index).filter((item) => item.body.kind === 'message').length
}

function blockedReason(input: RewindInput): string | null {
  if (input.hostBlockedReason) {
    return nativeChatRewindReasonCopy(input.hostBlockedReason)
  }
  if (input.support?.supported === false) {
    return nativeChatRewindReasonCopy(input.support.reason)
  }
  const { state } = input
  if (!input.support || !state.epoch || state.fence === null || state.status !== 'ready') {
    return nativeChatRewindUnavailableCopy()
  }
  return input.blocked ? nativeChatRewindReasonCopy('busy') : null
}

export function useNativeChatRewind(input: RewindInput) {
  const active = useRef(false)
  useLayoutEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const latest = useRef(input)
  useLayoutEffect(() => {
    latest.current = input
  }, [input])
  const inFlight = useRef(false)
  const [pending, setPending] = useState(false)
  const [settlement, setSettlement] = useState<{
    sessionId: string
    epoch: string
    nextEpoch?: string
  } | null>(null)
  const [failure, setFailure] = useState<{
    sessionId: string
    epoch: string | null
    message: string
  } | null>(null)
  const setError = (message: string | null) => {
    const current = latest.current
    setFailure(
      message ? { sessionId: current.sessionId, epoch: current.state.epoch, message } : null
    )
  }
  const awaitingReset =
    settlement?.sessionId === input.sessionId && settlement.epoch === input.state.epoch
  const confirmedResetPending = awaitingReset && Boolean(settlement?.nextEpoch)
  // The host also holds its recovery latch while our request is still in flight.
  const error =
    input.hostBlockedReason && !pending && !confirmedResetPending
      ? nativeChatRewindReasonCopy(input.hostBlockedReason)
      : failure?.sessionId === input.sessionId && failure.epoch === input.state.epoch
        ? failure.message
        : null
  const disabledReason =
    pending || awaitingReset
      ? awaitingReset && !settlement?.nextEpoch
        ? nativeChatRewindReasonCopy('outcome-unknown')
        : translate(
            'components.native-chat.rewind.pending',
            'Rewind is in progress. Wait for the conversation to reload.'
          )
      : blockedReason(input)
  const blockedRef = useRef(false)
  useLayoutEffect(() => {
    blockedRef.current = pending || awaitingReset || Boolean(input.hostBlockedReason)
  }, [pending, awaitingReset, input.hostBlockedReason])

  const request = useCallback(async (itemId: string, confirm: ConfirmationDialogContextValue) => {
    const captured = latest.current
    if (inFlight.current || blockedRef.current || blockedReason(captured)) {
      return
    }
    const expectedEpoch = captured.state.epoch!
    const count = countNativeChatRewindMessages(captured.state, itemId)
    if (!count) {
      return
    }
    inFlight.current = true
    blockedRef.current = true
    setPending(true)
    setError(null)
    let keepBlocked = false
    try {
      const confirmed = await confirm({
        title: translate('components.native-chat.rewind.title', 'Revert to here?'),
        description: translate(
          'components.native-chat.rewind.confirmation',
          'Discard this message and every later message ({{count}} in total)? This cannot be undone. The message returns to the composer so you can edit and resend it. File changes on disk will be kept.',
          { count }
        ),
        confirmLabel: translate('components.native-chat.rewind.confirm', 'Discard messages'),
        cancelLabel: translate('components.native-chat.rewind.cancel', 'Cancel'),
        confirmVariant: 'destructive',
        cancelVariant: 'ghost'
      })
      if (!confirmed) {
        return
      }
      const current = latest.current
      if (!active.current || current.sessionId !== captured.sessionId) {
        return
      }
      if (
        current.state.epoch !== expectedEpoch ||
        current.state.cursor?.sequence !== captured.state.cursor?.sequence
      ) {
        setError(nativeChatRewindReasonCopy('stale-epoch'))
        return
      }
      const blocked = blockedReason(current)
      if (blocked) {
        setError(blocked)
        return
      }
      const outcome = await current.send({ itemId, expectedEpoch })
      if (!active.current || latest.current.sessionId !== captured.sessionId) {
        return
      }
      if (outcome.kind === 'done') {
        const target = captured.state.items.find((item) => item.itemId === itemId)
        if (captured.composerScopeKey && target?.body.kind === 'message') {
          returnMessageToComposer(
            captured.composerScopeKey,
            `rewound-${itemId}`,
            target.body.blocks
          )
        }
        keepBlocked = latest.current.state.epoch === expectedEpoch
        setSettlement({
          sessionId: captured.sessionId,
          epoch: expectedEpoch,
          nextEpoch: outcome.value.epoch
        })
        return
      }
      if (outcome.kind === 'dropped' || latest.current.state.epoch !== expectedEpoch) {
        return
      }
      const reason = rewindFailureReason(outcome.failure)
      setError(nativeChatRewindReasonCopy(reason))
      if (reason === 'outcome-unknown') {
        keepBlocked = true
        setSettlement({ sessionId: captured.sessionId, epoch: expectedEpoch })
      }
    } finally {
      inFlight.current = false
      blockedRef.current = keepBlocked || Boolean(latest.current.hostBlockedReason)
      setPending(false)
    }
  }, [])
  /** Runs an action only while no rewind is pending or unresolved. */
  const unlessBlocked = useCallback(
    <A extends unknown[]>(run: (...input: A) => void) =>
      (...input: A): void => {
        if (!blockedRef.current) {
          run(...input)
        }
      },
    []
  )
  return {
    request,
    unlessBlocked,
    disabledReason,
    pending: pending || awaitingReset || Boolean(input.hostBlockedReason),
    blockedRef,
    error
  }
}

/** The rewind a structured session's user rows offer, sent through the session's own writes. */
export function useStructuredAgentSessionRewind(
  args: Omit<RewindInput, 'hostBlockedReason' | 'send'> & {
    hostBlockedReason: AgentSessionRewindReason | null
    write: StructuredAgentSessionWrite
  }
) {
  const { blocked, composerScopeKey, hostBlockedReason, sessionId, state, support, write } = args
  const input = useMemo<RewindInput>(
    () => ({
      sessionId,
      composerScopeKey,
      hostBlockedReason: hostBlockedReason ?? undefined,
      state,
      support,
      blocked,
      send: (fields) =>
        write<AgentSessionRewindResult>('agentSession.rewind', 'agentSession.rewind', fields)
    }),
    [blocked, composerScopeKey, hostBlockedReason, sessionId, state, support, write]
  )
  return useNativeChatRewind(input)
}
