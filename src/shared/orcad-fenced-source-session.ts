/**
 * A fenced host's `ssh:<target>` session partition is migration source: the manifest was exported
 * from it, and a downgraded build reads it back. This build hides the host's rows, so a renderer
 * save would rewrite that partition without them; it stays frozen until an older build changes it.
 */
import { parseExecutionHostId } from './execution-host'
import type { SshTarget } from './ssh-types'

export function isFencedOrcadSourceSessionPartition(
  getSshTarget: (id: string) => Pick<SshTarget, 'orcadFence'> | undefined,
  hostId: string | null | undefined
): boolean {
  const parsed = parseExecutionHostId(hostId)
  if (parsed?.kind !== 'ssh') {
    return false
  }
  const fence = getSshTarget(parsed.targetId)?.orcadFence
  return fence !== undefined && !fence.sourceChangedAt
}
