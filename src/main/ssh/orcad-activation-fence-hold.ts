/**
 * Why a fence answered "held": a run that is still working clears on its own and is retried on
 * a later connect. A stale fence with no journal is cleared here, since Recover would only drop it.
 * Only a stale lock over a journal, or a journal no fence guards, needs Recover: a live run
 * journals under a fresh fence too, and Recover cannot take a fresh fence anyway.
 */
import {
  orcadActivationFenceExists,
  orcadActivationTransactionRoot,
  withStaleOrcadActivationRecoveryLock,
  type OrcadActivationLockOptions
} from './orcad-activation-lock'
import { readOrcadActivationTransaction } from './orcad-activation-transaction-store'
import { isRelayInstallLockStale, RELAY_INSTALL_LOCK_NAME } from './ssh-relay-install-lock'
import { isWindowsRemoteHost, joinRemotePath } from './ssh-remote-platform'
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
import { execOrcadRemote } from './orcad-remote-runtime-control'
import { orcadRemoteBaseDir } from './orcad-remote-windows-node'
import { ORCAD_STATE_MUTATION_LOCK_DIRNAME } from './orcad-state-snapshot-members'
import { shellEscape } from './ssh-connection-utils'

export const ORCAD_ACTIVATION_FENCE_BUSY_CODE = 'orcad_activation_fence_busy'
export const ORCAD_ACTIVATION_RECOVERY_REQUIRED_CODE = 'orcad_activation_recovery_required'

export type OrcadActivationFenceRefusal = {
  code: string
  reason: string
  /** A stale fence no journal backed was cleared, so the attempt may run again at once. */
  cleared?: true
}

export async function orcadActivationFenceRefusal(
  options: OrcadActivationLockOptions,
  attempt: string
): Promise<OrcadActivationFenceRefusal> {
  const lockDir = joinRemotePath(
    options.host,
    orcadActivationTransactionRoot(options.host, options.remoteHome),
    RELAY_INSTALL_LOCK_NAME
  )
  // An unreadable answer reads as busy: retrying later is never wrong, a sticky failure can be.
  const journal = (await readOrcadActivationTransaction(options).catch(() => null)) !== null
  const stale =
    (await orphanExitedOwnFence(options, lockDir)) ||
    (await isRelayInstallLockStale(options.conn, lockDir, options.host))
  if (stale && !journal && (await clearAbandonedFence(options))) {
    // A wake or release cut short leaves a bare fence; Recover would only drop it (BUG-21).
    return {
      code: ORCAD_ACTIVATION_FENCE_BUSY_CODE,
      reason: `An abandoned fence held this host and was cleared; the ${attempt} is retried.`,
      cleared: true
    }
  }
  const stuck = stale || (journal && !(await orcadActivationFenceExists(options).catch(() => true)))
  return stuck
    ? {
        code: ORCAD_ACTIVATION_RECOVERY_REQUIRED_CODE,
        reason: `An interrupted update or stop holds this host, so the ${attempt} did not start. Recover it first.`
      }
    : {
        code: ORCAD_ACTIVATION_FENCE_BUSY_CODE,
        reason: `Another run is changing this host's managed server, so the ${attempt} did not start. It is retried on a later connect.`
      }
}

/** Takes the stale fence over and drops it, unless a journal appeared under it meanwhile. */
async function clearAbandonedFence(options: OrcadActivationLockOptions): Promise<boolean> {
  try {
    return await withStaleOrcadActivationRecoveryLock(options, async (lock) => {
      if (await readOrcadActivationTransaction(options)) {
        lock.retain()
        return false
      }
      return true
    })
  } catch {
    // Another client took it first, or the host did not answer: classify as before.
    return false
  }
}

/**
 * A fence this desktop's own earlier process held and exited without releasing (BUG-23) is aged at
 * once, so the stale rules above apply without the 20-minute wait. Process exit alone is not
 * enough: sshd keeps pty-less steps running, so the fence must also be quiet for three heartbeats
 * and no state mutation may still be live. POSIX only; Windows keeps the stale window.
 */
async function orphanExitedOwnFence(
  options: OrcadActivationLockOptions,
  lockDir: string
): Promise<boolean> {
  if (isWindowsRemoteHost(options.host) || !hasHeldOrcadFences()) {
    return false
  }
  try {
    const owner = await readBoundedOrcadRemoteRecord(
      options,
      joinRemotePath(options.host, lockDir, ORCAD_FENCE_OWNER_FILENAME),
      64
    )
    const token = owner.state === 'present' ? owner.raw.trim() : ''
    if (!token || !orcadFenceHeldByExitedProcess(token)) {
      return false
    }
    const command = exitedOwnFenceOrphanCommand(
      { lockDir, token },
      `${orcadRemoteBaseDir(options.host, options.remoteHome)}/${ORCAD_STATE_MUTATION_LOCK_DIRNAME}`
    )
    if ((await execOrcadRemote(options, command)).trim() !== 'ORPHANED') {
      return false
    }
    forgetHeldOrcadFence(token)
    return true
  } catch {
    // Unanswered: the stale window still applies.
    return false
  }
}

function exitedOwnFenceOrphanCommand(
  fence: { lockDir: string; token: string },
  mutation: string
): string {
  const lock = shellEscape(fence.lockDir)
  const owned = posixOrcadFenceOwnedTest(fence)
  const quiet = (path: string): string =>
    `[ -n "$(find ${path} -maxdepth 0 -mmin +3 2>/dev/null)" ]`
  return [
    `${owned} && ${quiet(lock)} || exit 0;`,
    `m=${shellEscape(mutation)};`,
    // A mutation lock is gone only once its group, its shell and its heartbeat all are.
    'if [ -d "$m" ]; then g=$(cat "$m/pgid" 2>/dev/null); p=$(cat "$m/pid" 2>/dev/null);',
    '{ [ -n "$g" ] && kill -0 "-$g" 2>/dev/null; } && exit 0;',
    '{ [ -n "$p" ] && kill -0 "$p" 2>/dev/null; } && exit 0;',
    `${quiet('"$m"')} || exit 0; fi;`,
    `touch -m -t 200001010000 ${lock} || exit 0;`,
    // A successor that took the fence between the check and the backdate gets its freshness back.
    `${owned} && echo ORPHANED || touch -c -m ${lock}`
  ].join(' ')
}
