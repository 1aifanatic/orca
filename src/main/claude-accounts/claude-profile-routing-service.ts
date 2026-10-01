import {
  CLAUDE_INJECTED_CONFIG_DIR_ENV,
  CLAUDE_PROFILE_POINTER_ENV,
  requireClaudeProfileRoutingCapability
} from '../../shared/claude-profile-routing'
import type {
  ClaudeProfileReadiness,
  ClaudeRateLimitAccountsState
} from '../../shared/managed-account-types'
import type { ClaudeProfileDescriptor } from './claude-profile-paths'
import { readClaudeProfilePointer } from './claude-profile-pointer'
import type { ClaudeAccountSelectionTarget } from './runtime-selection'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth-service'
import type { ClaudeProfileSetupReport } from './claude-profile-setup'
import type { ClaudeEnvPatch } from './environment'

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
  /** Derived from step-1 setup's own output, so no flag records that setup ran. */
  isProvisioned: (descriptor: ClaudeProfileLaunchDescriptor) => boolean
  readiness: (accountId: string) => ClaudeProfileReadiness
  /** Implemented on the owning host/guest; never materializes through a Windows UNC share. */
  prepare: (descriptor: ClaudeProfileLaunchDescriptor) => Promise<ClaudeProfileSetupReport>
  publish: (descriptor: ClaudeProfileLaunchDescriptor) => Promise<void>
  /** Removes the pointer so the shell refuses visibly; never throws. */
  withdraw: () => void
}

class ClaudeProfileSelectionChangedError extends Error {}

/** Settings remain authoritative; nothing in this class persists a second selection. */
export class ClaudeProfileRoutingService {
  private publishIssue: string | null = null
  private repair: Promise<unknown> | null = null
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
  /** Select and startup set the profile up (`always`); a launch only sets up one that never was. */
  async publish(
    target?: ClaudeAccountSelectionTarget,
    provisioning: 'always' | 'if-missing' = 'always'
  ): Promise<ClaudeProfileLaunchDescriptor> {
    try {
      const descriptor = this.resolve(target)
      if (
        descriptor.profile &&
        (provisioning === 'always' || !this.owner.isProvisioned(descriptor))
      ) {
        await this.provision(descriptor)
      }
      if (this.resolve(target).configHome !== descriptor.configHome) {
        throw new ClaudeProfileSelectionChangedError(
          'Claude account changed while preparing its profile; retry'
        )
      }
      await this.owner.publish(descriptor)
      this.publishIssue = null
      return descriptor
    } catch (error) {
      if (target?.runtime !== 'wsl') {
        this.publishIssue = error instanceof Error ? error.message : String(error)
        // Why: a pointer left naming the previous account would launch it silently. A newer
        // selection that raced this one owns the pointer, so that case leaves it alone.
        if (!(error instanceof ClaudeProfileSelectionChangedError)) {
          this.owner.withdraw()
        }
      }
      throw error
    }
  }
  /** Ownership refusal stops the caller; a worker fault on an already prepared profile only warns. */
  private async provision(descriptor: ClaudeProfileLaunchDescriptor): Promise<void> {
    const provisioned = this.owner.isProvisioned(descriptor)
    let report: ClaudeProfileSetupReport
    try {
      report = await this.owner.prepare(descriptor)
    } catch (error) {
      if (!provisioned) {
        throw error
      }
      console.warn('[claude-profile] Setup failed; launching the already prepared profile:', error)
      return
    }
    if (report.outcome === 'refused') {
      throw new Error('Selected Claude profile could not be prepared')
    }
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
    return this.preparation(await this.publish(target, 'if-missing'))
  }
  preparation(descriptor: ClaudeProfileLaunchDescriptor): ClaudeRuntimeAuthPreparation {
    return {
      configDir: descriptor.readHome,
      runtime: descriptor.target.runtime ?? 'host',
      wslDistro: descriptor.target.wslDistro ?? null,
      wslLinuxConfigDir: descriptor.target.runtime === 'wsl' ? descriptor.configHome : null,
      envPatch: this.envPatch(descriptor),
      stripAuthEnv: descriptor.profile !== null,
      provenance: descriptor.profile ? `profile:${descriptor.profile.accountId}` : 'system',
      profileLaunch: descriptor
    }
  }
  /**
   * A host pane's spawn env: its children keep this account until the pane reopens, while the
   * claude function re-reads the pointer. Never throws, so a non-Claude pane always opens.
   */
  terminalEnv(target?: ClaudeAccountSelectionTarget): ClaudeEnvPatch {
    try {
      return this.envPatch(this.resolve(target))
    } catch {
      return { [CLAUDE_PROFILE_POINTER_ENV]: this.pointerPath() }
    }
  }
  // Why no CLAUDE_CONFIG_DIR for System Default: the user's inherited value must pass through.
  private envPatch(descriptor: ClaudeProfileLaunchDescriptor): ClaudeEnvPatch {
    const home = descriptor.profile ? descriptor.configHome : undefined
    return {
      [CLAUDE_PROFILE_POINTER_ENV]: descriptor.pointerPath,
      ...(home ? { CLAUDE_CONFIG_DIR: home, [CLAUDE_INJECTED_CONFIG_DIR_ENV]: home } : {})
    }
  }
  /** Never throws: readiness is per account, and a stale pointer is republished in the background. */
  describeAccounts(state: ClaudeRateLimitAccountsState): ClaudeRateLimitAccountsState {
    const accounts = state.accounts.map((account) => ({
      ...account,
      profileReadiness: this.owner.readiness(account.id)
    }))
    if (this.pointerIsCurrent()) {
      return { ...state, accounts }
    }
    this.repair ??= this.publish(undefined, 'if-missing')
      .catch(() => {})
      .finally(() => {
        this.repair = null
      })
    return {
      ...state,
      accounts,
      profileRoutingIssue: this.publishIssue ?? 'Claude account selection is being published'
    }
  }
  private pointerIsCurrent(): boolean {
    try {
      const descriptor = this.resolve()
      return readClaudeProfilePointer(descriptor.pointerPath) === (descriptor.profile?.home ?? null)
    } catch {
      return false
    }
  }
  historyRoots(target?: ClaudeAccountSelectionTarget): string[] {
    return [...new Set(this.owner.readHomes(target))]
  }
}
