import { existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { writeManagedScript } from '../agent-hooks/installer-utils'
import { restoreManagedScript } from '../agent-hooks/managed-hook-script-refresh'
import {
  buildWindowsHookEnvironmentGuardLines,
  buildWindowsHookStdinDrainEpilogue
} from '../agent-hooks/hook-stdin-contract'

const PAYLOAD_FILE_NAME = 'claude-hook-impl.cmd'

export function getWindowsClaudeHookPayloadPath(entryPath: string): string {
  return join(dirname(entryPath), PAYLOAD_FILE_NAME)
}

export function getWindowsClaudeHookFileStatus(
  status: AgentHookInstallStatus,
  entryPath: string
): AgentHookInstallStatus {
  if (
    status.state === 'installed' &&
    (!existsSync(entryPath) || !existsSync(getWindowsClaudeHookPayloadPath(entryPath)))
  ) {
    return { ...status, state: 'partial', detail: 'Managed Claude hook script is missing' }
  }
  return status
}

export function installWindowsClaudeHookFiles(entryPath: string, payload: string): void {
  writeManagedScript(getWindowsClaudeHookPayloadPath(entryPath), payload)
  writeManagedScript(entryPath, getWindowsClaudeHookEntry())
}

export function removeWindowsClaudeHookFiles(entryPath: string): string | null {
  try {
    rmSync(entryPath, { force: true })
    rmSync(getWindowsClaudeHookPayloadPath(entryPath), { force: true })
    return null
  } catch (error) {
    return `Hooks removed from settings, but script cleanup failed: ${String(error)}`
  }
}

export function getWindowsClaudeHookEntry(): string {
  return [
    '@echo off',
    // Inherited delayed expansion would eat exclamation marks in the profile path.
    'setlocal DisableDelayedExpansion',
    `set "ORCA_CLAUDE_HOOK_IMPL=%~dp0${PAYLOAD_FILE_NAME}"`,
    'if not exist "%ORCA_CLAUDE_HOOK_IMPL%" goto :missing_impl',
    // Transfer control without CALL's second expansion of percent signs in the path.
    '"%ORCA_CLAUDE_HOOK_IMPL%"',
    'exit /b %errorlevel%',
    ':missing_impl',
    'echo {}',
    ...buildWindowsHookEnvironmentGuardLines(),
    ...buildWindowsHookStdinDrainEpilogue(),
    ''
  ].join('\r\n')
}

export async function refreshWindowsClaudeHookFiles(
  entryPath: string,
  payload: string,
  registered: boolean
): Promise<void> {
  // A deleted entry is repairable while settings still refer to it; an orphan payload is not consent.
  if (!registered && !existsSync(entryPath)) {
    return
  }
  // Publish the payload first so a failed migration leaves the previous single-file hook intact.
  await restoreManagedScript(getWindowsClaudeHookPayloadPath(entryPath), payload)
  await restoreManagedScript(entryPath, getWindowsClaudeHookEntry())
}
