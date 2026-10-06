import type { ClaudeAccountSignIn } from '../../../../shared/managed-account-types'
import { quotePowerShellLiteral } from '../../../../shared/powershell-native-argument'
import { quotePosixShell } from '../../../../shared/wsl-login-shell-command'
import { buildSkillSetupTerminalCommand } from './CliSkillRuntimeSetup'

/**
 * The visible sign-in command for an account folder (superset addAccountCommand). Windows always
 * signs in from PowerShell, which hands a WSL account's command to the distro's login shell.
 */
export function buildClaudeSignInCommand(
  signIn: Pick<ClaudeAccountSignIn, 'configDir' | 'runtime' | 'wslDistro'>,
  platform: 'win32' | 'posix'
): { command: string; shellOverride?: string } {
  const posix = `CLAUDE_CONFIG_DIR=${quotePosixShell(signIn.configDir)} claude auth login`
  if (platform !== 'win32') {
    return { command: posix }
  }
  if (signIn.runtime === 'wsl') {
    return {
      command: buildSkillSetupTerminalCommand(
        posix,
        'powershell.exe',
        { runtime: 'wsl', wslDistro: signIn.wslDistro, label: '' },
        'win32'
      ),
      shellOverride: 'powershell.exe'
    }
  }
  return {
    command: `$env:CLAUDE_CONFIG_DIR = ${quotePowerShellLiteral(signIn.configDir)}; claude auth login`,
    shellOverride: 'powershell.exe'
  }
}
