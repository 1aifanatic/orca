import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'

/** Non-blocking note that a delete went ahead past an older terminal service that did not answer. */
export function showUncheckedTerminalServicesToast(result: RemoveWorktreeResult | undefined): void {
  if (!result?.uncheckedTerminalServices?.length) {
    return
  }
  toast.info(
    translate(
      'auto.components.sidebar.UncheckedTerminalServicesToast.5b1e0c7d2a',
      'Workspace deleted. An older terminal service didn’t answer.'
    ),
    {
      description: translate(
        'auto.components.sidebar.UncheckedTerminalServicesToast.9c4f6a3e18',
        'Any terminal it still runs for this workspace wasn’t checked. Settings › Manage Sessions shows it once it answers.'
      )
    }
  )
}
