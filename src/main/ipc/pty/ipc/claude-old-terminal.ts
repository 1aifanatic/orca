import { getClaudeProfileRouter } from '../../../claude-accounts/claude-profile-installed-router'
import { getPtyIpc } from '../../pty-host-bindings'
import {
  CLAUDE_ACCOUNT_FUNCTION_DAEMON_PROTOCOL_VERSION,
  CLAUDE_ACCOUNT_FUNCTION_REVERTED_DAEMON_PROTOCOL_VERSION
} from '../../../daemon/daemon-protocol-version'
import { isTerminalOnLegacyDaemon } from '../../../daemon/daemon-provider-state'

// Why not every older daemon: v42 shipped the same claude function and pointer; only v43, the revert, lacked them.
function lacksClaudeFunction(protocolVersion: number): boolean {
  return (
    protocolVersion < CLAUDE_ACCOUNT_FUNCTION_DAEMON_PROTOCOL_VERSION ||
    protocolVersion === CLAUDE_ACCOUNT_FUNCTION_REVERTED_DAEMON_PROTOCOL_VERSION
  )
}

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
        isTerminalOnLegacyDaemon(args.id, lacksClaudeFunction) &&
        (getClaudeProfileRouter()?.systemDefaultRunsAnotherAccount() ?? true)
      )
    }
  )
}
