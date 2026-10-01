import { admitRemoteForegroundEvidence } from '../../shared/remote-foreground-evidence-admission'
import { isClientOnlyUnverifiableInspection } from '../../shared/terminal-process-inspection'
import type { PtyProcessInspection } from './pty-process-inspection'

/**
 * What a PTY's execution host says about its own shell being back in front:
 * - `shell`: proven; whatever ran in the pane has ended.
 * - `other`: something else is in front (an agent, another job, a stopped job), or the host's
 *   answer could not be trusted (stale, another incarnation, an unreadable process table).
 * - `unprovable`: the host answered but has no way to tell (a WSL guest, a Windows host, a host
 *   that predates foreground evidence).
 * A host that cannot be reached rejects instead: loss of contact is never evidence of an exit.
 */
export type ShellForegroundProof = 'shell' | 'other' | 'unprovable'

/** Reads the fenced foreground evidence a terminal daemon or SSH relay inspection carries. */
export function shellForegroundProofFromInspection(
  inspection: PtyProcessInspection,
  expected: {
    ptyId: string
    incarnationId: string | null
    requestStartedAtMonotonic: number
  }
): ShellForegroundProof {
  // Why throw: a client-only verdict (transport loss) is no answer from the host at all.
  if (isClientOnlyUnverifiableInspection(inspection)) {
    throw new Error(`execution host gave no answer: ${inspection.reason}`)
  }
  if (!('foregroundProcessEvidence' in inspection) || !inspection.foregroundProcessEvidence) {
    return 'unprovable'
  }
  const evidence = admitRemoteForegroundEvidence(inspection.foregroundProcessEvidence, {
    expectedPtyId: expected.ptyId,
    expectedIncarnationId: expected.incarnationId,
    requestStartedAtMonotonic: expected.requestStartedAtMonotonic,
    receivedAtMonotonic: performance.now(),
    lastAuthorityGeneration: null,
    lastObservationEpoch: -1
  })
  if (evidence?.verdict === 'unverifiable') {
    return evidence.reason === 'windows_ssh_foreground_unavailable' ? 'unprovable' : 'other'
  }
  // Why TEMPORARY: this evidence cannot see a stopped job, so a Ctrl+Z'd agent reads as `shell`.
  return evidence?.verdict === 'live' &&
    evidence.processName === null &&
    evidence.fence.platform === 'posix' &&
    evidence.fence.foregroundPgid === evidence.fence.shellPid
    ? 'shell'
    : 'other'
}

/** The terminal daemon's own confirm proves a shell only after a full-screen exit, so its fenced
 *  evidence is read next; that evidence is POSIX-only, so a Windows daemon cannot tell. */
export async function proveDaemonShellForeground(args: {
  ptyId: string
  incarnationId: string | null
  platform: NodeJS.Platform
  confirmShellForeground: () => Promise<boolean>
  inspectProcess: () => Promise<PtyProcessInspection>
}): Promise<ShellForegroundProof> {
  if (await args.confirmShellForeground()) {
    return 'shell'
  }
  if (args.platform === 'win32') {
    return 'unprovable'
  }
  const requestStartedAtMonotonic = performance.now()
  return shellForegroundProofFromInspection(await args.inspectProcess(), {
    ptyId: args.ptyId,
    incarnationId: args.incarnationId,
    requestStartedAtMonotonic
  })
}
