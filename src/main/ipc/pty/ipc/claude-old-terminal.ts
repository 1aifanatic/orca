import { getClaudeProfileRouter } from '../../../claude-accounts/claude-profile-installed-router'
import { getPtyIpc } from '../../pty-host-bindings'
import { CLAUDE_ACCOUNT_FUNCTION_DAEMON_PROTOCOL_VERSION } from '../../../daemon/daemon-protocol-version'
import { isTerminalFromBeforeDaemonProtocol } from '../../../daemon/daemon-provider-state'

type Deps = { getLocalPtyProviderStartupPromise: () => Promise<void> | undefined }

/** Whether a pane's daemon predates the claude function, so its claude runs another account. */
export function installPtyClaudeOldTerminalIpcHandler(deps: Deps): void {
  getPtyIpc().handle(
    'pty:openedBeforeClaudeAccounts',
    async (_event, args: { id: string }): Promise<boolean> => {
      if (typeof args?.id !== 'string') {
        return false
      }
      // Why: the pre-swap provider does not own restored daemon ids.
      await deps.getLocalPtyProviderStartupPromise()
      // Why also the account: when System default is signed in to the selected one, this
      // terminal's claude already runs it.
      return (
        isTerminalFromBeforeDaemonProtocol(
          args.id,
          CLAUDE_ACCOUNT_FUNCTION_DAEMON_PROTOCOL_VERSION
        ) &&
        (getClaudeProfileRouter()?.systemDefaultRunsAnotherAccount() ?? true)
      )
    }
  )
}
