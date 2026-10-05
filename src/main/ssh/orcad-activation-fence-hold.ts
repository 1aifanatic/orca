/**
 * Why a fence answered "held": a run that is still working clears on its own and is retried on
 * a later connect. Only a lock past its stale age, or a journal no fence guards, needs Recover: a
 * live run journals under a fresh fence too, and Recover cannot take a fresh fence anyway.
 */
import {
  orcadActivationFenceExists,
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
  const stuck =
    (await isRelayInstallLockStale(options.conn, lockDir, options.host)) ||
    ((await readOrcadActivationTransaction(options).catch(() => null)) !== null &&
      !(await orcadActivationFenceExists(options).catch(() => true)))
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
