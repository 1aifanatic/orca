import { ipcMain } from 'electron'
import type { ClaudeAccountService } from '../claude-accounts/service'
import type { ClaudeAccountSelectionTarget } from '../claude-accounts/runtime-selection'
import type {
  ClaudeAccountSignIn,
  ClaudeRateLimitAccountsState,
  ClaudeSignInRequest
} from '../../shared/managed-account-types'
import { CLAUDE_ACCOUNT_FUNCTION_DAEMON_PROTOCOL_VERSION } from '../daemon/daemon-protocol-version'
import { hasTerminalsFromBeforeDaemonProtocol } from '../daemon/daemon-provider-state'

export function registerClaudeAccountHandlers(
  claudeAccounts: ClaudeAccountService,
  olderTerminalsRunning: () => boolean = () =>
    hasTerminalsFromBeforeDaemonProtocol(CLAUDE_ACCOUNT_FUNCTION_DAEMON_PROTOCOL_VERSION)
): void {
  // Why per call: the notice ends as soon as the last terminal from before the update closes.
  const withTerminalNotice = async (
    state: Promise<ClaudeRateLimitAccountsState> | ClaudeRateLimitAccountsState
  ): Promise<ClaudeRateLimitAccountsState> => {
    const resolved = await state
    return resolved.accounts.length > 0 && olderTerminalsRunning()
      ? { ...resolved, olderTerminalsRunning: true }
      : resolved
  }
  ipcMain.handle('claudeAccounts:list', () => withTerminalNotice(claudeAccounts.listAccounts()))
  ipcMain.handle('claudeAccounts:beginSignIn', (_event, args?: ClaudeSignInRequest) =>
    claudeAccounts.beginSignIn(args)
  )
  ipcMain.handle(
    'claudeAccounts:finishSignIn',
    (_event, args: Omit<ClaudeAccountSignIn, 'configDir'>) =>
      withTerminalNotice(claudeAccounts.finishSignIn(args))
  )
  ipcMain.handle(
    'claudeAccounts:cancelSignIn',
    (_event, args: Omit<ClaudeAccountSignIn, 'configDir'>) => claudeAccounts.cancelSignIn(args)
  )
  ipcMain.handle('claudeAccounts:remove', (_event, args: { accountId: string }) =>
    withTerminalNotice(claudeAccounts.removeAccount(args.accountId))
  )
  ipcMain.handle(
    'claudeAccounts:select',
    (_event, args: { accountId: string | null } & ClaudeAccountSelectionTarget) =>
      withTerminalNotice(
        args.runtime
          ? claudeAccounts.selectAccountForTarget(args.accountId, args)
          : claudeAccounts.selectAccount(args.accountId)
      )
  )
}
