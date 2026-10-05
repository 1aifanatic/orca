/**
 * Starting a managed orcad that is installed and activated but not running, most often one
 * that stopped itself after idling. A stopped server is just "not running": it is neither a
 * failure nor evidence about terminals, which the daemon owns and which outlive orcad.
 */
import type { ServeReadiness } from '../server/serve-readiness'
import { readOrcadActivationRecord } from './orcad-activation-record-store'
import {
  orcadActivationFenceExists,
  releaseOrcadActivationFence,
  withOrcadActivationLock
} from './orcad-activation-lock'
import { readOrcadActivationTransaction } from './orcad-activation-transaction-store'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-deploy-helpers'
import { orcadLivenessProbeCommand, parseOrcadLiveness } from './orcad-remote-launch'
import { execOrcadRemote } from './orcad-remote-runtime-control'
import {
  ensureOrcadSlotServing,
  orcadSlotDir,
  resolveOrcadSlotIdentity,
  type OrcadSlotOptions
} from './orcad-recovery-slot'

export type OrcadManagedWake =
  | { outcome: 'serving' | 'not-activated' | 'unverifiable' }
  /** An update, rollback or recovery holds the host; it owns which slot serves. */
  | { outcome: 'fenced' }
  | { outcome: 'started'; readiness: ServeReadiness }

/** Launches the active slot only on proven exit; a live or unprovable process is left alone. */
export async function wakeStoppedManagedOrcad(
  options: OrcadSlotOptions,
  onStarting: () => void = () => {}
): Promise<OrcadManagedWake> {
  const before = await readOrcadActivationRecord(options)
  if (!before.active) {
    return { outcome: 'not-activated' }
  }
  const liveness = await slotLiveness(options, before.active)
  if (liveness !== 'DEAD') {
    return { outcome: liveness === 'LIVE' ? 'serving' : 'unverifiable' }
  }
  const host = wakeHostKey(options)
  if (await orcadActivationFenceExists(options)) {
    if (!(await releaseOwnInterruptedWakeFence(options, host))) {
      return { outcome: 'fenced' }
    }
  }
  return withOrcadActivationLock(
    options,
    async (): Promise<OrcadManagedWake> => {
      // Re-read under the fence: another client may have activated or started a slot meanwhile.
      const active = (await readOrcadActivationRecord(options)).active
      if (!active) {
        return { outcome: 'not-activated' }
      }
      const identity = await resolveOrcadSlotIdentity(options, active)
      onStarting()
      try {
        return { outcome: 'started', readiness: await ensureOrcadSlotServing(options, identity) }
      } catch (error) {
        // A lost connection keeps the fence on the host; only this client knows it is its own.
        if (isUnconfirmedSshCommandTermination(error)) {
          interruptedWakes.add(host)
        }
        throw error
      }
    },
    () => ({ outcome: 'fenced' })
  )
}

// Hosts where this client's own wake lost its connection while holding the fence.
const interruptedWakes = new Set<string>()

function wakeHostKey(options: OrcadSlotOptions): string {
  return `${options.conn.getTarget().id}\0${options.remoteHome}`
}

/**
 * A wake journals nothing, so a fence with no journal that this client's own interrupted wake
 * left is released; the slot was just proven exited and orcad's instance lock bars a double start.
 */
async function releaseOwnInterruptedWakeFence(
  options: OrcadSlotOptions,
  host: string
): Promise<boolean> {
  if (!interruptedWakes.has(host) || (await readOrcadActivationTransaction(options))) {
    return false
  }
  await releaseOrcadActivationFence(options)
  interruptedWakes.delete(host)
  return true
}

async function slotLiveness(
  options: OrcadSlotOptions,
  version: string
): Promise<'LIVE' | 'DEAD' | 'UNKNOWN'> {
  return parseOrcadLiveness(
    await execOrcadRemote(
      options,
      orcadLivenessProbeCommand(options.host, orcadSlotDir(options, version))
    )
  )
}
