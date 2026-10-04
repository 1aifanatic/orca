import { z } from 'zod'
import { requiredString } from './rpc-param-primitives'

/** A managed Orca server on this host, by environment name or id. */
export const ManagedServerSelector = z.object({
  selector: requiredString('Missing required --environment')
})

export const ManagedServerUpdate = ManagedServerSelector.extend({
  // Restarts over live terminals when the update would otherwise defer.
  force: z.boolean().optional()
})
