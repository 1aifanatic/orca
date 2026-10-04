/**
 * The managed-orcad half of a hostile-host cell: on a fresh host, resolve the context, deploy
 * and activate orcad, and prove it runs on the cell's `managedRuntime` and on nothing else.
 */
import { posix } from 'node:path'
import { expect } from 'vitest'
import { NODE_RUNTIME_ASSETS, pinnedNodeRuntimeAsset } from '../../shared/node-runtime-pin'
import { ORCAD_MANAGED_REMOTE_PORT } from '../../shared/orcad-managed-runtime'
import { ORCAD_RUNTIMES_DIRNAME } from '../../shared/orcad-artifacts'
import type { SshTarget } from '../../shared/ssh-types'
import { readOrcadActivationRecord } from './orcad-activation-record-store'
import { managedOrcadSlot } from './orcad-managed-runtime-context'
import { orcadSlotDir } from './orcad-recovery-slot'
import { resolveOrcadRemoteContext } from './orcad-remote-context'
import { deployOrcad } from './orcad-remote-deploy'
import { orcadLivenessProbeCommand, parseOrcadLiveness } from './orcad-remote-launch'
import { execOrcadRemote } from './orcad-remote-runtime-control'
import { decommissionRemoteOrcad } from './orcad-remote-stop'
import type { HostileHostCellCore } from './ssh-hostile-host-cells'
import { connectHostileHost } from './ssh-hostile-host-test-harness'
import { hostExecStatus, type HostileHostTarget } from './ssh-hostile-host-test-fixture'

const EMPTY_CENSUS = { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: null }

export async function proveManagedOrcadCell(
  cell: HostileHostCellCore,
  target: HostileHostTarget,
  sshTarget: SshTarget
): Promise<void> {
  const expected = cell.managedRuntime
  if (!expected) {
    throw new Error(`${cell.id} names no managed runtime`)
  }
  const conn = await connectHostileHost(sshTarget)
  try {
    const context = await resolveOrcadRemoteContext(sshTarget, conn)
    expect(context.serverTarget).toBe(expected)
    const slot = managedOrcadSlot(context, ORCAD_MANAGED_REMOTE_PORT)
    const deployed = await deployOrcad({
      ...slot,
      target: context.serverTarget,
      census: EMPTY_CENSUS
    })
    // The message carries the deferral code and reason, which toMatchObject's diff omits.
    expect(deployed, JSON.stringify(deployed)).toMatchObject({ outcome: 'installed-and-activated' })
    const slotDir = orcadSlotDir(slot, deployed.fullVersion)
    const liveness = async (): Promise<string> =>
      parseOrcadLiveness(await execOrcadRemote(slot, orcadLivenessProbeCommand(slot.host, slotDir)))
    expect(await liveness()).toBe('LIVE')

    // Only the expected runtime reached the host: a default one beside it is the wrong upload.
    const runtimes = posix.join(posix.dirname(slotDir), ORCAD_RUNTIMES_DIRNAME)
    const runtimeDir = (sha: string): string => posix.join(runtimes, `node-${sha}`)
    const { executableSha256 } = pinnedNodeRuntimeAsset(expected)
    expect(await hostExecStatus(target, `test -x '${runtimeDir(executableSha256)}/bin/node'`)).toBe(
      0
    )
    for (const asset of Object.values(NODE_RUNTIME_ASSETS)) {
      if (asset.executableSha256 !== executableSha256) {
        expect(
          await hostExecStatus(target, `test -e '${runtimeDir(asset.executableSha256)}'`)
        ).not.toBe(0)
      }
    }

    const decommission = await decommissionRemoteOrcad({
      ...slot,
      record: await readOrcadActivationRecord(slot),
      census: EMPTY_CENSUS
    })
    expect(decommission, JSON.stringify(decommission)).toMatchObject({
      outcome: 'decommissioned',
      version: deployed.fullVersion
    })
    expect(await liveness()).toBe('DEAD')
  } finally {
    await conn.disconnect().catch(() => {})
  }
}
