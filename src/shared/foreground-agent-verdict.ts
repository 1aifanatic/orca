import { recognizeAgentProcess } from './agent-process-recognition'
import type { RemoteForegroundEvidence } from './foreground-process-evidence'
import { isShellProcess } from './shell-process-detection'
import {
  isClientOnlyUnverifiableInspection,
  type TerminalProcessInspection
} from './terminal-process-inspection'

/** One observation of what owns a PTY's foreground, before any exit rule is applied. */
export type ForegroundAgentObservation =
  /** A fresh local or daemon read of the foreground process name. */
  | { kind: 'process-name'; processName: string | null | undefined }
  /** An execution-host record already fenced to this PTY; null when none was admissible. */
  | { kind: 'host-evidence'; evidence: RemoteForegroundEvidence | null }
  /** The host predates foreground evidence, so it can never name a shell. */
  | { kind: 'host-without-evidence' }
  /** No answer: transport loss, timeout, or a failed read. */
  | { kind: 'unavailable' }

export type ForegroundAgentJudgement = {
  verdict: 'live' | 'unverifiable' | 'exited'
  /** The observed process name; host records only ever name recognized agents. */
  processName: string | null
  /** False when this host can never prove a shell, so only the shell's own 133;D can retire an agent. */
  canCertifyExit: boolean
}

const WSL_BRIDGE_NAMES = new Set(['wsl', 'wsl.exe', 'wslhost', 'wslhost.exe'])

function unverifiable(processName: string | null, canCertifyExit = true): ForegroundAgentJudgement {
  return { verdict: 'unverifiable', processName, canCertifyExit }
}

/** The single rule for foreground agent identity: only a positive shell fact is an exit. */
export function judgeForegroundAgent(
  observation: ForegroundAgentObservation
): ForegroundAgentJudgement {
  switch (observation.kind) {
    case 'unavailable':
      return unverifiable(null)
    case 'host-without-evidence':
      return unverifiable(null, false)
    case 'process-name': {
      const processName = observation.processName?.trim() ? observation.processName : null
      if (!processName) {
        return unverifiable(null)
      }
      if (recognizeAgentProcess(processName)) {
        return { verdict: 'live', processName, canCertifyExit: true }
      }
      if (isShellProcess(processName)) {
        return { verdict: 'exited', processName, canCertifyExit: true }
      }
      // Why: the WSL bridge hides the distro's process tree, so no Windows read can name its shell.
      const basename = processName.trim().toLowerCase().split(/[\\/]/).pop() ?? ''
      return unverifiable(processName, !WSL_BRIDGE_NAMES.has(basename))
    }
    case 'host-evidence': {
      const { evidence } = observation
      if (!evidence) {
        return unverifiable(null)
      }
      if (evidence.verdict === 'exited') {
        return { verdict: 'exited', processName: null, canCertifyExit: true }
      }
      if (evidence.verdict === 'unverifiable') {
        return unverifiable(null, evidence.reason !== 'windows_ssh_foreground_unavailable')
      }
      if (recognizeAgentProcess(evidence.processName)) {
        return { verdict: 'live', processName: evidence.processName, canCertifyExit: true }
      }
      if (evidence.shellForeground === true) {
        return { verdict: 'exited', processName: null, canCertifyExit: true }
      }
      // Absent on hosts that predate the field; false means some other program is in front.
      return unverifiable(null, evidence.shellForeground !== undefined)
    }
  }
}

/** Classify an inspect-process answer; `admit` fences the host record to the current PTY binding. */
export function observeHostInspection(
  inspection: TerminalProcessInspection | string | null | undefined,
  admit: (evidence: unknown) => RemoteForegroundEvidence | null
): ForegroundAgentObservation {
  if (inspection === null || inspection === undefined) {
    return { kind: 'unavailable' }
  }
  if (typeof inspection === 'string') {
    return { kind: 'host-without-evidence' }
  }
  if (isClientOnlyUnverifiableInspection(inspection)) {
    return inspection.reason === 'old_host'
      ? { kind: 'host-without-evidence' }
      : { kind: 'unavailable' }
  }
  if (inspection.foregroundProcessEvidence === undefined) {
    return { kind: 'host-without-evidence' }
  }
  return { kind: 'host-evidence', evidence: admit(inspection.foregroundProcessEvidence) }
}
