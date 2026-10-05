/**
 * Why a fence answered "held": a run that is still working clears on its own and is retried on
 * a later connect, while an interrupted run (a journal, or a lock past its stale age) needs Recover.
 */
import {
  orcadActivationTransactionRoot,
  type OrcadActivationLockOptions
} from './orcad-activation-lock'
import { readOrcadActivationTransaction } from './orcad-activation-transaction-store'
import { isRelayInstallLockStale, RELAY_INSTALL_LOCK_NAME } from './ssh-relay-install-lock'
import { joinRemotePath } from './ssh-remote-platform'

export const ORCAD_ACTIVATION_FENCE_BUSY_CODE = 'orcad_activation_fence_busy'
export const ORCAD_ACTIVATION_RECOVERY_REQUIRED_CODE = 'orcad_activation_recovery_required'

export type OrcadActivationFenceRefusal = { code: string; reason: string }

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
  const journal = await readOrcadActivationTransaction(options).catch(() => null)
  const stuck =
    journal !== null || (await isRelayInstallLockStale(options.conn, lockDir, options.host))
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
