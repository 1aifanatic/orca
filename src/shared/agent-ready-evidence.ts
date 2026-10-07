import { detectAgentStatusFromTitle } from './agent-detection'
import { isExpectedAgentProcess } from './agent-process-recognition'
import { isShellProcess } from './shell-process-detection'

export type AgentReadyReason = 'title-idle' | 'foreground-match' | 'child-process' | 'timeout'
export type AgentReadyResult = { ready: boolean; reason: AgentReadyReason }
type ProcessObservation = { foregroundProcess: string | null; hasChildProcesses: boolean }

/** The desktop paste's fallback evidence, ordered from strongest to weakest. */
export function readAgentReadyEvidence(
  titles: readonly string[],
  process: ProcessObservation | null,
  expectedProcess: string,
  attempt: number
): Exclude<AgentReadyReason, 'timeout'> | null {
  if (titles.some((title) => detectAgentStatusFromTitle(title) === 'idle')) {
    return 'title-idle'
  }
  const foreground = process?.foregroundProcess?.toLowerCase() ?? ''
  if (isExpectedAgentProcess(foreground, expectedProcess)) {
    return 'foreground-match'
  }
  // Give shell startup children three probes to settle, and never accept a foreground shell.
  if (attempt >= 4 && process?.hasChildProcesses && !isShellProcess(foreground)) {
    return 'child-process'
  }
  return null
}

export type AgentReadyEvidenceHost = {
  readTitles: () => readonly string[]
  inspectProcess: () => Promise<ProcessObservation | null>
  assertCurrent?: () => void
}

/** The budget bounds polling; an inspection already awaiting its host may settle later. */
export async function waitForAgentReadyEvidence(
  host: AgentReadyEvidenceHost,
  expectedProcess: string,
  timeoutMs: number
): Promise<AgentReadyResult> {
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  while (Date.now() < deadline) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
    attempt += 1
    host.assertCurrent?.()
    const titleReason = readAgentReadyEvidence(host.readTitles(), null, expectedProcess, attempt)
    if (titleReason) {
      return { ready: true, reason: titleReason }
    }
    let process: ProcessObservation | null = null
    try {
      process = await host.inspectProcess()
    } catch {
      // Transient inspection failures are retried on the next probe.
    }
    host.assertCurrent?.()
    const reason = readAgentReadyEvidence([], process, expectedProcess, attempt)
    if (reason) {
      return { ready: true, reason }
    }
  }
  return { ready: false, reason: 'timeout' }
}
