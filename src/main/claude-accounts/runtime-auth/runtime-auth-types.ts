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
