/**
 * How a launch's execution ends for its caller and its record: the error that carries whether it
 * provably ran nothing, the bookkeeping that never fails a launch, and the answer for a launch whose
 * tab the user closed while it started.
 */

import {
  AGENT_LAUNCH_TAB_CLOSED_CODE,
  AgentLaunchTabClosedError
} from '../../../../shared/agent-launch-tab-closed'
import type { RpcContext } from '../core'
import { readsAgentLaunchTabClosed } from './agent-launch-replay'
import type { EarlyAgentLaunchTab } from './agent-launch-tab-publication'
import type { AgentLaunchResult } from '../../../../shared/agent-launch-intent'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { closeStructuredAgentSessionSurface } from '../../structured-agent-session-surface-close'

export class AgentLaunchExecutionError extends Error {
  constructor(
    cause: unknown,
    /** Decided once, by the launch that ran; a later reader cannot re-derive it from the error. */
    readonly failedWithoutEffects: boolean
  ) {
    super('agent_session_operation_unknown', { cause })
  }
}

/** Both surfaces ask the same owner immediately before their next effect. */
export function assertAgentLaunchSurfaceOwnerOpen(
  early: Pick<EarlyAgentLaunchTab, 'closedByUser'> | null,
  failedWithoutEffects: boolean
): void {
  if (early?.closedByUser()) {
    throw new AgentLaunchExecutionError(new AgentLaunchTabClosedError(), failedWithoutEffects)
  }
}

export function settleQuietly(settlement: Promise<void>): Promise<void> {
  return settlement.catch((error: unknown) => {
    console.warn('[agent-launch] the launch settled, its operation row did not', error)
  })
}

/** Runs a launch whose tab may already be showing. Its pane reads how the launch ended off the
 *  launch record, which every path below settles before this returns. */
export async function withEarlyTab<T>(
  early: EarlyAgentLaunchTab | null,
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run()
  } finally {
    early?.finish()
  }
}

/** What a caller hears for a launch whose tab the user closed: the definite answer when it reads
 *  that word, the uncertain one it always got otherwise. */
export function agentLaunchTabClosedAnswer(context: RpcContext): Error {
  return readsAgentLaunchTabClosed(context)
    ? Object.assign(new Error(AGENT_LAUNCH_TAB_CLOSED_CODE), { code: AGENT_LAUNCH_TAB_CLOSED_CODE })
    : new Error('agent_session_operation_unknown')
}

/** Close the known surface; only a proven pre-effect close may overwrite the operation as failed. */
export async function settleLaunchWhoseTabWasClosed(
  context: RpcContext,
  early: EarlyAgentLaunchTab,
  evidence: {
    failedWithoutEffects: boolean
    error?: unknown
    result?: AgentLaunchResult
    admission: {
      fail: (code: string) => Promise<void>
      settle: (result: AgentLaunchResult) => Promise<void>
    }
  }
): Promise<never> {
  const { result, admission, failedWithoutEffects, error } = evidence
  if (result?.outcome.kind === 'structured') {
    await closeStructuredAgentSessionSurface(
      context.runtime,
      getStructuredAgentSessionHost(),
      result.outcome.sessionId,
      'user-close'
    ).catch((error: unknown) =>
      console.warn('[agent-launch] closing the created chat failed', error)
    )
  } else {
    const handle =
      result?.outcome.handle ?? context.runtime.getTerminalHandleForPaneKey(early.paneKey)
    if (handle) {
      await context.runtime.closeTerminal(handle).catch(() => {})
    }
  }
  if (failedWithoutEffects) {
    await settleQuietly(admission.fail(AGENT_LAUNCH_TAB_CLOSED_CODE))
  } else if (result) {
    await settleQuietly(admission.settle(result))
  }
  const confirmedClose =
    result !== undefined ||
    failedWithoutEffects ||
    (error instanceof AgentLaunchExecutionError && error.cause instanceof AgentLaunchTabClosedError)
  throw new AgentLaunchExecutionError(
    confirmedClose ? new AgentLaunchTabClosedError() : error,
    failedWithoutEffects
  )
}
