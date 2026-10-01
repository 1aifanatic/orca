import type { RuntimeTerminalSend } from '../../../../../../shared/runtime-terminal-contracts'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import {
  buildDispatchPreamble,
  dispatchPreambleSendOptions
} from '../../../../orchestration/preamble'
import {
  sendStructuredWorkerPreamble,
  type StructuredWorkerPreambleDelivery
} from '../../orchestration-structured-worker-session'
import type { WorkerTurnStartObservation } from './worker-start-turn-observation'
import type { createStructuredWorkerSessionForWorktree } from './worker-topology'

type StructuredSession = Awaited<ReturnType<typeof createStructuredWorkerSessionForWorktree>> | null

/**
 * Hands a started worker the dispatch preamble, over whichever transport it has.
 *
 * The preamble itself is identical for both: a worker is taught the same verbs whichever mode it
 * runs in, and only the delivery differs — a PTY write returns a queued/accepted receipt, while a
 * structured turn is acknowledged, still held for an agent that has not started, or throws. Held is
 * a turn start nobody observed yet: the start is left unknown, not torn down.
 */
export async function deliverWorkerDispatchPreamble(args: {
  runtime: OrcaRuntimeService
  structuredSession: StructuredSession
  terminalHandle: string
  dispatchId: string
  dispatchDepth: number
  taskId: string
  taskSpec: string
  coordinatorHandle: string
  devMode: boolean | undefined
  requestId: string
  /** How long a structured preamble waits for its agent. */
  preambleBudgetMs?: number
}): Promise<{
  prompt?: RuntimeTerminalSend['prompt']
  structuredTurnStart?: WorkerTurnStartObservation
}> {
  const { runtime, structuredSession, terminalHandle } = args
  const preamble = buildDispatchPreamble({
    // Depth only. A worker is taught the same verbs whichever mode it runs in, so this must not
    // become a second gate: resolving the caller's worktree is what lets a structured worker
    // dispatch sub-workers exactly like a PTY one.
    canDispatchSubWorkers: args.dispatchDepth < runtime.getNestedWorkerMaxDepth(),
    taskId: args.taskId,
    dispatchId: args.dispatchId,
    taskSpec: args.taskSpec,
    coordinatorHandle: args.coordinatorHandle,
    workerHandle: terminalHandle,
    devMode: args.devMode,
    cliCommand: runtime.getTerminalOrchestrationCliCommand(terminalHandle)
  })
  if (structuredSession) {
    const delivery = await sendStructuredWorkerPreamble({
      host: structuredSession.host,
      sessionId: structuredSession.identity.sessionId,
      dispatchId: args.dispatchId,
      preamble,
      ...(args.preambleBudgetMs === undefined ? {} : { budgetMs: args.preambleBudgetMs })
    })
    return { structuredTurnStart: structuredPreambleTurnStart(delivery) }
  }
  return {
    prompt: (
      await runtime.sendTerminalAgentPrompt(
        terminalHandle,
        preamble,
        dispatchPreambleSendOptions(args.requestId)
      )
    ).prompt
  }
}

/** What a structured preamble's delivery says about the worker's turn start. */
export function structuredPreambleTurnStart(
  delivery: StructuredWorkerPreambleDelivery
): WorkerTurnStartObservation {
  if (delivery.state === 'accepted') {
    return { verdict: 'observed' }
  }
  return {
    verdict: 'unobserved',
    reason: delivery.startFailure
      ? `The worker's agent did not start: ${delivery.startFailure.reason} The dispatch ` +
        'preamble waits for its next start; if the worker then reports, this Dispatch ' +
        'settles normally.'
      : 'The dispatch preamble was accepted, but the agent had not started to take it. ' +
        'It is delivered when the agent starts; if the worker then reports, this ' +
        'Dispatch settles normally.'
  }
}
