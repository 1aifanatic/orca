import type { ClaudeProfileLaunchDescriptor } from '../claude-profile-routing-owner'
import type { ClaudeEnvPatch } from '../environment'

export type ClaudeRuntimeAuthPreparation = {
  profileIssue?: string
  profileLaunch?: ClaudeProfileLaunchDescriptor
  configDir: string
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
  wslLinuxConfigDir?: string | null
  envPatch: ClaudeEnvPatch
  stripAuthEnv: boolean
  managedRefreshDeferredByLivePty?: boolean
  provenance: string
}

/** The CLAUDE_CONFIG_DIR the launched Claude sees: the patched profile home or System Default's own. */
export function claudeLaunchConfigDir(
  preparation: ClaudeRuntimeAuthPreparation | undefined
): string | undefined {
  return preparation?.envPatch.CLAUDE_CONFIG_DIR ?? preparation?.profileLaunch?.inheritedConfigDir
}
