import type {
  ClaudeProfileHostAccess,
  ClaudeProfileLaunchDescriptor,
  ClaudeProfileRoutingOwner
} from './claude-profile-routing-owner'
import type { ClaudeProfileSetupReport } from './claude-profile-setup'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'
import type { ClaudeEnvPatch } from './environment'
import {
  CLAUDE_INJECTED_CONFIG_DIR_ENV,
  CLAUDE_PROFILE_POINTER_ENV
} from '../../shared/claude-profile-routing'

/** Ownership refusal stops the caller; a worker fault on an already prepared profile only warns. */
export async function provisionClaudeLaunchProfile(
  owner: Pick<ClaudeProfileRoutingOwner, 'isProvisioned' | 'prepare'>,
  descriptor: ClaudeProfileLaunchDescriptor,
  access: ClaudeProfileHostAccess
): Promise<void> {
  const provisioned = owner.isProvisioned(descriptor)
  let report: ClaudeProfileSetupReport
  try {
    report = await owner.prepare(descriptor, access)
  } catch (error) {
    if (!provisioned || descriptor.target.runtime === 'wsl') {
      throw error
    }
    console.warn('[claude-profile] Setup failed; launching the already prepared profile:', error)
    return
  }
  if (report.outcome === 'refused') {
    throw new Error('Selected Claude profile could not be prepared')
  }
}

export function claudeProfileLaunchPreparation(
  descriptor: ClaudeProfileLaunchDescriptor
): ClaudeRuntimeAuthPreparation {
  return {
    configDir: descriptor.readHome,
    runtime: descriptor.target.runtime ?? 'host',
    wslDistro: descriptor.target.wslDistro ?? null,
    wslLinuxConfigDir: descriptor.target.runtime === 'wsl' ? descriptor.configHome : null,
    envPatch: claudeProfileLaunchEnvPatch(descriptor),
    stripAuthEnv: descriptor.profile !== null,
    provenance: descriptor.profile ? `profile:${descriptor.profile.accountId}` : 'system',
    profileLaunch: descriptor
  }
}

// Why no CLAUDE_CONFIG_DIR for System Default: the user's inherited value must pass through.
export function claudeProfileLaunchEnvPatch(
  descriptor: ClaudeProfileLaunchDescriptor
): ClaudeEnvPatch {
  const home = descriptor.profile ? descriptor.configHome : undefined
  return {
    [CLAUDE_PROFILE_POINTER_ENV]: descriptor.pointerPath,
    ...(home ? { CLAUDE_CONFIG_DIR: home, [CLAUDE_INJECTED_CONFIG_DIR_ENV]: home } : {})
  }
}
