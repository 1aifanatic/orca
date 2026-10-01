import { join } from 'node:path'
import {
  CLAUDE_PROFILE_POINTER_ENV,
  requireClaudeProfileRoutingCapability
} from '../../shared/claude-profile-routing'
import type { ClaudeProfileDescriptor } from './claude-profile-paths'
import type { ClaudeAccountSelectionTarget } from './runtime-selection'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth-service'
import type { ClaudeProfileSetupReport } from './claude-profile-setup'

export type ClaudeProfileLaunchDescriptor = {
  profile: ClaudeProfileDescriptor | null
  /** Paths belong to the execution host; readHome may be the host's UNC access path. */
  configHome: string
  readHome: string
  defaultHome: string
  pointerPath: string
  target: ClaudeAccountSelectionTarget
}

export type ClaudeProfileRoutingOwner = {
  resolve: (target?: ClaudeAccountSelectionTarget) => ClaudeProfileLaunchDescriptor
  pointerPath: () => string
  targets: () => ClaudeAccountSelectionTarget[]
  /** All known owned profiles, including unselected profiles with private/retained history. */
  readHomes: (target?: ClaudeAccountSelectionTarget) => string[]
  capabilities: (target: ClaudeAccountSelectionTarget) => readonly string[]
  /** Implemented on the owning host/guest; never materializes through a Windows UNC share. */
  prepare: (
    descriptor: ClaudeProfileLaunchDescriptor,
    trustKeys?: readonly string[]
  ) => Promise<ClaudeProfileSetupReport>
  publish: (descriptor: ClaudeProfileLaunchDescriptor) => Promise<void>
}

/** Settings remain authoritative; nothing in this class persists a second selection. */
export class ClaudeProfileRoutingService {
  constructor(private readonly owner: ClaudeProfileRoutingOwner) {}
  resolve(target?: ClaudeAccountSelectionTarget): ClaudeProfileLaunchDescriptor {
    const descriptor = this.owner.resolve(target)
    if (descriptor.target.runtime === 'wsl' && !descriptor.target.wslDistro) {
      throw new Error('Claude profile requires a specific WSL distro')
    }
    requireClaudeProfileRoutingCapability(this.owner.capabilities(descriptor.target))
    if (!descriptor.configHome || !descriptor.readHome || !descriptor.pointerPath) {
      throw new Error('Claude profile execution host is unavailable')
    }
    return descriptor
  }
  async publish(
    target?: ClaudeAccountSelectionTarget,
    trustKeys?: readonly string[]
  ): Promise<ClaudeProfileLaunchDescriptor> {
    const descriptor = this.resolve(target)
    if (descriptor.profile) {
      const report = await this.prepareProfile(descriptor, trustKeys)
      if (report.outcome === 'refused') {
        throw new Error('Selected Claude profile could not be prepared')
      }
    }
    if (this.resolve(target).configHome !== descriptor.configHome) {
      throw new Error('Claude account changed while preparing its profile; retry')
    }
    await this.owner.publish(descriptor)
    return descriptor
  }
  prepareProfile(
    descriptor: ClaudeProfileLaunchDescriptor,
    trustKeys?: readonly string[]
  ): Promise<ClaudeProfileSetupReport> {
    return this.owner.prepare(descriptor, trustKeys)
  }
  pointerPath(): string {
    return this.owner.pointerPath()
  }
  async startup(): Promise<void> {
    for (const target of this.owner.targets()) {
      await this.publish(target)
    }
  }
  async prepare(target?: ClaudeAccountSelectionTarget): Promise<ClaudeRuntimeAuthPreparation> {
    return this.preparation(await this.publish(target))
  }
  preparation(descriptor: ClaudeProfileLaunchDescriptor): ClaudeRuntimeAuthPreparation {
    return {
      configDir: descriptor.readHome,
      runtime: descriptor.target.runtime ?? 'host',
      wslDistro: descriptor.target.wslDistro ?? null,
      wslLinuxConfigDir: descriptor.target.runtime === 'wsl' ? descriptor.configHome : null,
      envPatch: {
        CLAUDE_CONFIG_DIR: descriptor.profile ? descriptor.configHome : '',
        [CLAUDE_PROFILE_POINTER_ENV]: descriptor.pointerPath
      },
      stripAuthEnv: descriptor.profile !== null,
      provenance: descriptor.profile ? `profile:${descriptor.profile.accountId}` : 'system',
      profileLaunch: descriptor
    }
  }
  historyRoots(target?: ClaudeAccountSelectionTarget): string[] {
    return [...new Set(this.owner.readHomes(target))]
  }
  globalSkillsRoot(target?: ClaudeAccountSelectionTarget): string {
    return join(this.resolve(target).defaultHome, 'skills')
  }
}
