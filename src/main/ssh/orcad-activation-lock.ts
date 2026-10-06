/**
 * One activation or rollback per host, and the fence an interrupted one leaves behind.
 *
 * The lock lives in the transaction root, so releasing it also removes the journal. A run
 * that cannot prove the host is back to one serving slot retains both and marks the lock
 * ownerless; only recovery may take a retained fence over, and it waits out the install lock's
 * stale window only for a fence whose holder may still be working.
 */
import {
  execOrcadRemote,
  withoutAbortSignal,
  type OrcadRemoteExecTarget
} from './orcad-remote-runtime-control'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-deploy-helpers'
import {
  acquireInstallLock,
  RELAY_INSTALL_LOCK_NAME,
  RemoteInstallLockBusyError
} from './ssh-relay-install-lock'
import {
  orphanInstallLockCommand,
  probeInstallLockExistsCommand
} from './ssh-relay-install-lock-commands'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import { removeRemoteFileCommand, removeRemoteTreeCommand } from './ssh-remote-commands'
import { orcadRemoteBaseDir, orcadWindowsHostOpCommand } from './orcad-remote-windows-node'
import { isWindowsRemoteHost, joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import {
  ORCAD_ACTIVATION_TRANSACTION_DIRNAME,
  ORCAD_ACTIVATION_TRANSACTION_FILENAME
} from './orcad-activation-transaction'

const ORCAD_ACTIVATION_MAX_READINESS_TIMEOUT_MS = 5 * 60_000

export type OrcadActivationLockOptions = OrcadRemoteExecTarget & { remoteHome: string }

export type OrcadActivationLockControl = {
  /** Keep the fence if the run throws: a journal now describes host state. */
  retainOnError(): void
  /** Keep the fence even on return: the host is not proven back to one serving slot. */
  retain(): void
  /** The host is proven back on its recorded slot: release even if the run then throws. */
  recovered(): void
}

export function orcadActivationTransactionRoot(
  host: RemoteHostPlatform,
  remoteHome: string
): string {
  return joinRemotePath(host, remoteHome, RELAY_REMOTE_DIR, ORCAD_ACTIVATION_TRANSACTION_DIRNAME)
}

/** Bounded so a crashed holder's lock goes stale long before a live holder could still be waiting. */
export function resolveOrcadActivationReadinessTimeout(
  configured: number | undefined,
  fallback: number
): number {
  const timeout = configured ?? fallback
  if (
    !Number.isSafeInteger(timeout) ||
    timeout <= 0 ||
    timeout > ORCAD_ACTIVATION_MAX_READINESS_TIMEOUT_MS
  ) {
    throw new Error(
      `orcad readiness timeout must be an integer from 1 to ${ORCAD_ACTIVATION_MAX_READINESS_TIMEOUT_MS}ms`
    )
  }
  return timeout
}

// Long enough for a brief hold (a wake, a retried lock command), short beside a lifecycle queue.
const ORCAD_ACTIVATION_FENCE_WAIT_MS = 5_000

/** A fence still held after a short wait answers `held()`: a retained one never clears by waiting. */
export async function withOrcadActivationLock<T>(
  options: OrcadActivationLockOptions,
  run: (control: OrcadActivationLockControl) => Promise<T>,
  held: () => T | Promise<T>
): Promise<T> {
  const lockRoot = orcadActivationTransactionRoot(options.host, options.remoteHome)
  try {
    await acquireInstallLock(options.conn, lockRoot, options.host, {
      signal: options.signal,
      relayGcClaim: false,
      // A retained fence means state ownership is unresolved. Age cannot make it safe.
      allowStaleTakeover: false,
      waitTimeoutMs: ORCAD_ACTIVATION_FENCE_WAIT_MS
    })
  } catch (error) {
    if (error instanceof RemoteInstallLockBusyError) {
      return await held()
    }
    throw error
  }
  let retainOnError = false
  let retain = false
  try {
    const result = await run({
      retainOnError: () => {
        retainOnError = true
      },
      retain: () => {
        retain = true
      },
      recovered: () => {
        retainOnError = false
      }
    })
    await (retain ? orphanRetainedFence(options) : releaseActivationFence(options, lockRoot))
    return result
  } catch (error) {
    // A remote mutation whose teardown is unconfirmed may still be running: keep its fence fresh.
    if (!isUnconfirmedSshCommandTermination(error)) {
      await (
        retainOnError ? orphanRetainedFence(options) : releaseActivationFence(options, lockRoot)
      ).catch((releaseError: unknown) => {
        console.warn(
          `[orcad] Failed to release activation lock after an error: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`
        )
      })
    }
    throw error
  }
}

/** Takes over only a stale or previous-boot fence; a fresh one throws `RemoteInstallLockBusyError`. */
export async function withStaleOrcadActivationRecoveryLock<T>(
  options: OrcadActivationLockOptions,
  run: (control: Pick<OrcadActivationLockControl, 'retain'>) => Promise<T>
): Promise<T> {
  const lockRoot = orcadActivationTransactionRoot(options.host, options.remoteHome)
  await acquireInstallLock(options.conn, lockRoot, options.host, {
    signal: options.signal,
    relayGcClaim: false,
    allowStaleTakeover: true,
    waitTimeoutMs: 0
  })
  let retain = false
  let result: T
  try {
    result = await run({ retain: () => (retain = true) })
  } catch (error) {
    // Any throw keeps the fence: recovery failed to prove one serving slot.
    if (!isUnconfirmedSshCommandTermination(error)) {
      await orphanRetainedFence(options).catch(() => undefined)
    }
    throw error
  }
  await (retain ? orphanRetainedFence(options) : releaseActivationFence(options, lockRoot))
  return result
}

/**
 * A fence this run keeps after it is done: nothing of ours still works under it, so the next
 * recovery may take it over at once. Left fresh, every failed recovery would restart the stale
 * window it waits out, and the host could never be recovered.
 */
async function orphanRetainedFence(options: OrcadActivationLockOptions): Promise<void> {
  const lockDir = joinRemotePath(
    options.host,
    orcadActivationTransactionRoot(options.host, options.remoteHome),
    RELAY_INSTALL_LOCK_NAME
  )
  try {
    await execOrcadRemote(
      withoutAbortSignal(options),
      orphanInstallLockCommand(options.host, lockDir)
    )
  } catch (error) {
    // Best effort: the fence still holds; recovery then waits out the stale window as before.
    console.warn(
      `[orcad] Could not mark a retained activation fence as ownerless: ${String(error)}`
    )
  }
}

/** Whether any lock is held; a lost probe throws rather than reading as open. */
export async function orcadActivationFenceExists(
  options: OrcadActivationLockOptions
): Promise<boolean> {
  const lockDir = joinRemotePath(
    options.host,
    orcadActivationTransactionRoot(options.host, options.remoteHome),
    RELAY_INSTALL_LOCK_NAME
  )
  const answer = (
    await execOrcadRemote(options, probeInstallLockExistsCommand(options.host, lockDir))
  ).trim()
  if (answer !== 'LOCKED' && answer !== 'OPEN') {
    throw new Error('The activation fence probe returned no verifiable answer.')
  }
  return answer === 'LOCKED'
}

/** Drops a fence this client knows it left behind; never a fence another run may own. */
export function releaseOrcadActivationFence(options: OrcadActivationLockOptions): Promise<void> {
  return releaseActivationFence(
    options,
    orcadActivationTransactionRoot(options.host, options.remoteHome)
  )
}

function releaseActivationFence(
  options: OrcadActivationLockOptions,
  lockRoot: string
): Promise<void> {
  // Journal first: a release cut short must leave a lock without a journal, never the reverse.
  const journal = joinRemotePath(options.host, lockRoot, ORCAD_ACTIVATION_TRANSACTION_FILENAME)
  // Why no signal: a cancelled run must still be able to drop a fence it proved unnecessary.
  const target = withoutAbortSignal(options)
  if (isWindowsRemoteHost(options.host)) {
    // `&&` does not parse under a PowerShell DefaultShell, so the two steps are two execs.
    const baseDir = orcadRemoteBaseDir(options.host, options.remoteHome)
    return execOrcadRemote(
      target,
      orcadWindowsHostOpCommand(options.host, baseDir, 'remove-file', [journal])
    ).then(() =>
      execOrcadRemote(
        target,
        orcadWindowsHostOpCommand(options.host, baseDir, 'remove-tree', [lockRoot])
      ).then(() => undefined)
    )
  }
  return execOrcadRemote(
    target,
    `${removeRemoteFileCommand(options.host, journal)} && ${removeRemoteTreeCommand(options.host, lockRoot)}`
  ).then(() => undefined)
}
