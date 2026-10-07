/**
 * A lock this desktop's own earlier process took and exited without releasing (BUG-23): the
 * activation fence, or a version dir's install lock a quit left mid-upload. It is aged at once,
 * so the stale rules apply without the 20-minute wait. Process exit alone is not enough: sshd
 * keeps pty-less steps running, so the lock must also be quiet for three heartbeats and, for the
 * fence, no state mutation may still be live. Windows hosts run the same check in the host script,
 * where a mutation's holder counts as gone only once its pid and creation time prove it exited.
 */
import {
  ORCAD_FENCE_OWNER_FILENAME,
  posixOrcadFenceOwnedTest
} from './orcad-activation-fence-scope'
import {
  forgetHeldOrcadFence,
  orcadFenceTokensHeldByExitedProcesses
} from './orcad-held-fence-tokens'
import { readBoundedOrcadRemoteRecord } from './orcad-remote-record-file'
import { execOrcadRemote, type OrcadRemoteExecTarget } from './orcad-remote-runtime-control'
import {
  installOrcadWindowsHostScript,
  orcadWindowsHostOpCommand
} from './orcad-remote-windows-node'
import { ORCAD_STATE_MUTATION_LOCK_DIRNAME } from './orcad-state-snapshot-members'
import { shellEscape } from './ssh-connection-utils'
import { isWindowsRemoteHost, joinRemotePath } from './ssh-remote-platform'

// Keeps the Windows command line short; an older token left out only waits out the stale window.
const MAX_WINDOWS_CANDIDATES = 16

/**
 * True once the lock is backdated. `baseDir` is `~/.orca-remote`; `guardsStateMutation` means a
 * live state mutation there keeps the lock.
 */
export async function orphanExitedOwnLock(
  target: OrcadRemoteExecTarget,
  lockDir: string,
  scope: { baseDir: string; guardsStateMutation: boolean }
): Promise<boolean> {
  const exited = orcadFenceTokensHeldByExitedProcesses()
  if (exited.length === 0) {
    return false
  }
  try {
    const token = isWindowsRemoteHost(target.host)
      ? await orphanOnWindows(target, lockDir, scope, exited.slice(-MAX_WINDOWS_CANDIDATES))
      : await orphanOnPosix(target, lockDir, scope, exited)
    if (token === null || !exited.includes(token)) {
      return false
    }
    forgetHeldOrcadFence(token)
    return true
  } catch {
    // Unanswered: the stale window still applies.
    return false
  }
}

async function orphanOnPosix(
  target: OrcadRemoteExecTarget,
  lockDir: string,
  scope: { baseDir: string; guardsStateMutation: boolean },
  exited: string[]
): Promise<string | null> {
  const owner = await readBoundedOrcadRemoteRecord(
    target,
    joinRemotePath(target.host, lockDir, ORCAD_FENCE_OWNER_FILENAME),
    64
  )
  const token = owner.state === 'present' ? owner.raw.trim() : ''
  if (!exited.includes(token)) {
    return null
  }
  const mutationLock = scope.guardsStateMutation
    ? joinRemotePath(target.host, scope.baseDir, ORCAD_STATE_MUTATION_LOCK_DIRNAME)
    : null
  const command = exitedOwnLockOrphanCommand({ lockDir, token }, mutationLock)
  return (await execOrcadRemote(target, command)).trim() === 'ORPHANED' ? token : null
}

/** The host script reads the owner itself, so one node.exe answers with the token it aged. */
async function orphanOnWindows(
  target: OrcadRemoteExecTarget,
  lockDir: string,
  scope: { baseDir: string; guardsStateMutation: boolean },
  exited: string[]
): Promise<string | null> {
  await installOrcadWindowsHostScript(target, scope.baseDir)
  const output = await execOrcadRemote(
    target,
    orcadWindowsHostOpCommand(target.host, scope.baseDir, 'fence-orphan-exited', [
      lockDir,
      scope.guardsStateMutation ? '1' : '0',
      ...exited
    ])
  )
  const match = /^ORPHANED (\S+)$/u.exec(output.trim().split(/\r?\n/u).at(-1) ?? '')
  return match ? match[1] : null
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
