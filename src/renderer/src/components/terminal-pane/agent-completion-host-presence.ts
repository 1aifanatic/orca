import { isSameAgentProcess } from '../../../../shared/agent-process-presence'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { ProcessMonitorOptions } from './agent-completion-process-types'

/** Undefined alone admits the temporary no-process-identity compatibility path. */
export function inspectAgentCompletionHostPresence({
  options,
  state,
  establishAgentEvidence,
  clearAgentRunEvidence,
  dispatchCompletion
}: ProcessMonitorOptions): Promise<boolean> | undefined {
  const owner = options.getAgentPresence?.()
  const expected = owner?.process
  if (!expected) {
    return undefined
  }
  return (async () => {
    const verdict = owner.ended
      ? 'exited'
      : ((await options.checkAgentPresence?.(expected)) ?? 'unverifiable')
    const current = options.getAgentPresence?.()
    if (state.disposed || !current?.process || !isSameAgentProcess(expected, current.process)) {
      return false
    }
    state.pendingProcessExit = null
    if (verdict === 'unverifiable') {
      return false
    }
    if (verdict === 'live') {
      if (isTuiAgent(owner.agent)) {
        state.lastForegroundAgent = { agent: owner.agent, processName: owner.agent }
      }
      establishAgentEvidence()
      return true
    }
    const exited = isTuiAgent(owner.agent) ? { agent: owner.agent, processName: owner.agent } : null
    if (exited && state.hasAgentRunEvidence) {
      dispatchCompletion('process-exit', exited.processName, {
        terminalIdleConfirmed: true,
        completionIdentity: {
          source: 'process-exit',
          identity: `${expected.platform}:${expected.pid}:${expected.startTime}`,
          agentIdentity: exited.agent
        }
      })
      options.onForegroundAgentExited?.(exited)
    }
    state.lastForegroundAgent = null
    clearAgentRunEvidence()
    return false
  })()
}
