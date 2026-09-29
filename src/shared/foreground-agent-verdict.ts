import { isAgentForegroundWrapperProcess, recognizeAgentProcess } from './agent-process-recognition'
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
  /** Why an answered read can never show this pane's shell; absent when a re-read might. */
  blindness?: ForegroundBlindness
}

/** 'bridge' and 'other-program' blind only a pane whose shell marks no commands (OSC 133). */
type ForegroundBlindness = 'host-cannot-read' | 'agent-host' | 'bridge' | 'other-program'

/** Re-read delays after a first read that could not decide, shared by main and the renderer. */
export const FOREGROUND_CONFIRM_RETRY_DELAYS_MS = [1200, 6000] as const

const WSL_BRIDGE_NAMES = new Set(['wsl', 'wslhost'])
// Why: these run the agent out of the pane's process sight, and their inner shell marks never reach it.
const AGENT_HOST_NAMES = new Set([
  'tmux',
  'screen',
  'ssh',
  'mosh',
  'mosh-client',
  'et',
  'docker',
  'podman'
])

function unverifiable(
  processName: string | null,
  canCertifyExit = true,
  blindness?: ForegroundBlindness
): ForegroundAgentJudgement {
  return {
    verdict: 'unverifiable',
    processName,
    canCertifyExit,
    ...(blindness ? { blindness } : {})
  }
}

function blindnessForProgram(processName: string): ForegroundBlindness | undefined {
  const basename = (processName.trim().toLowerCase().split(/[\\/]/).pop() ?? '').replace(
    /\.exe$/,
    ''
  )
  if (WSL_BRIDGE_NAMES.has(basename)) {
    return 'bridge'
  }
  if (AGENT_HOST_NAMES.has(basename)) {
    return 'agent-host'
  }
  // A wrapper (node, python) may still resolve to the agent on a re-read.
  return isAgentForegroundWrapperProcess(processName) ? undefined : 'other-program'
}

/**
 * The one blindness rule main and the renderer share: on a blind pane the agent's own
 * idle-to-neutral title retires it; on a sighted pane the confirming read decides. An unanswered
 * read is never blindness, because loss of contact is not evidence of exit.
 */
export function isAgentExitBlind(
  judgement: ForegroundAgentJudgement,
  paneMarksCommands: boolean
): boolean {
  if (judgement.verdict !== 'unverifiable') {
    return false
  }
  switch (judgement.blindness) {
    case 'host-cannot-read':
    case 'agent-host':
      return true
    case 'bridge':
    case 'other-program':
      return !paneMarksCommands
    case undefined:
      return false
  }
}

/** The single rule for foreground agent identity: only a positive shell fact is an exit. */
export function judgeForegroundAgent(
  observation: ForegroundAgentObservation
): ForegroundAgentJudgement {
  switch (observation.kind) {
    case 'unavailable':
      return unverifiable(null)
    case 'host-without-evidence':
      return unverifiable(null, false, 'host-cannot-read')
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
      const blindness = blindnessForProgram(processName)
      return unverifiable(processName, blindness !== 'bridge', blindness)
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
        if (evidence.reason === 'windows_ssh_foreground_unavailable') {
          return unverifiable(null, false, 'host-cannot-read')
        }
        return unverifiable(
          null,
          true,
          evidence.reason === 'multiplexer_boundary' ? 'agent-host' : undefined
        )
      }
      if (recognizeAgentProcess(evidence.processName)) {
        return { verdict: 'live', processName: evidence.processName, canCertifyExit: true }
      }
      if (evidence.shellForeground === true) {
        return { verdict: 'exited', processName: null, canCertifyExit: true }
      }
      // Absent on hosts that predate the field; false means some other program is in front.
      return evidence.shellForeground === undefined
        ? unverifiable(null, false, 'host-cannot-read')
        : unverifiable(null, true, 'other-program')
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
