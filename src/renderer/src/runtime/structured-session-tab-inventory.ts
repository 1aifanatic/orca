import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { refreshLocalStructuredSessionTabs } from './local-structured-session-tabs-sync'
import { readPairedHostStructuredSessionTabs } from './paired-host-structured-session-census'
import type { RuntimeClientTarget } from './runtime-client-target'

/**
 * The owning host's current tab inventory. This machine's runtime is read through the local sync,
 * which applies what it lists; a paired host's tabs reach the store through that host's mirror
 * stream, so this only reads them.
 */
export async function readStructuredSessionTabInventory(
  target: RuntimeClientTarget
): Promise<RuntimeMobileSessionTabsResult[]> {
  return target.kind === 'local'
    ? refreshLocalStructuredSessionTabs(undefined, { authoritative: true })
    : readPairedHostStructuredSessionTabs(target.environmentId)
}
