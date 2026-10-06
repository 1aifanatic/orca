/**
 * A lock this desktop's own earlier process took and exited without releasing (BUG-23): the
 * activation fence, or a version dir's install lock a quit left mid-upload. It is aged at once,
 * so the stale rules apply without the 20-minute wait. Process exit alone is not enough: sshd
 * keeps pty-less steps running, so the lock must also be quiet for three heartbeats and, for the
 * fence, no state mutation may still be live. POSIX only; Windows keeps the stale window.
 */
import {
  ORCAD_FENCE_OWNER_FILENAME,
  posixOrcadFenceOwnedTest
} from './orcad-activation-fence-scope'
import {
  forgetHeldOrcadFence,
  hasHeldOrcadFences,
  orcadFenceHeldByExitedProcess
} from './orcad-held-fence-tokens'
import { readBoundedOrcadRemoteRecord } from './orcad-remote-record-file'
import { execOrcadRemote, type OrcadRemoteExecTarget } from './orcad-remote-runtime-control'
import { shellEscape } from './ssh-connection-utils'
import { isWindowsRemoteHost, joinRemotePath } from './ssh-remote-platform'

/** True once the lock is backdated; `mutationLock` names a state-mutation lock that keeps it. */
export async function orphanExitedOwnLock(
  target: OrcadRemoteExecTarget,
  lockDir: string,
  mutationLock: string | null
): Promise<boolean> {
  if (isWindowsRemoteHost(target.host) || !hasHeldOrcadFences()) {
    return false
  }
  try {
    const owner = await readBoundedOrcadRemoteRecord(
      target,
      joinRemotePath(target.host, lockDir, ORCAD_FENCE_OWNER_FILENAME),
      64
    )
    const token = owner.state === 'present' ? owner.raw.trim() : ''
    if (!token || !orcadFenceHeldByExitedProcess(token)) {
      return false
    }
    const command = exitedOwnLockOrphanCommand({ lockDir, token }, mutationLock)
    if ((await execOrcadRemote(target, command)).trim() !== 'ORPHANED') {
      return false
    }
    forgetHeldOrcadFence(token)
    return true
  } catch {
    // Unanswered: the stale window still applies.
    return false
  }
}

function exitedOwnLockOrphanCommand(
  lock: { lockDir: string; token: string },
  mutationLock: string | null
): string {
  const dir = shellEscape(lock.lockDir)
  const owned = posixOrcadFenceOwnedTest(lock)
  const quiet = (path: string): string =>
    `[ -n "$(find ${path} -maxdepth 0 -mmin +3 2>/dev/null)" ]`
  return [
    `${owned} && ${quiet(dir)} || exit 0;`,
    ...(mutationLock
      ? [
          `m=${shellEscape(mutationLock)};`,
          // A mutation lock is gone only once its group, its shell and its heartbeat all are.
          'if [ -d "$m" ]; then g=$(cat "$m/pgid" 2>/dev/null); p=$(cat "$m/pid" 2>/dev/null);',
          '{ [ -n "$g" ] && kill -0 "-$g" 2>/dev/null; } && exit 0;',
          '{ [ -n "$p" ] && kill -0 "$p" 2>/dev/null; } && exit 0;',
          `${quiet('"$m"')} || exit 0; fi;`
        ]
      : []),
    `touch -m -t 200001010000 ${dir} || exit 0;`,
    // A successor that took the lock between the check and the backdate gets its freshness back.
    `${owned} && echo ORPHANED || touch -c -m ${dir}`
  ].join(' ')
}
