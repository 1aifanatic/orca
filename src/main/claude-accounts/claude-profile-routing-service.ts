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
  refresh?: (target?: ClaudeAccountSelectionTarget) => Promise<void>
  pointerPath: (target?: ClaudeAccountSelectionTarget) => string
  targets: () => ClaudeAccountSelectionTarget[]
  /** All known owned profiles, including unselected profiles with private/retained history. */
  readHomes: (
    target?: ClaudeAccountSelectionTarget,
    surface?: 'projects' | 'transcripts'
  ) => string[]
  capabilities: (target: ClaudeAccountSelectionTarget) => readonly string[]
  /** Derived from step-1 setup's own output, so no flag records that setup ran. */
  isProvisioned: (descriptor: ClaudeProfileLaunchDescriptor) => boolean
  readiness: (accountId: string) => ClaudeProfileReadiness
  /** Implemented on the owning host/guest; never materializes through a Windows UNC share. */
  prepare: (descriptor: ClaudeProfileLaunchDescriptor) => Promise<ClaudeProfileSetupReport>
  trust?: (descriptor: ClaudeProfileLaunchDescriptor, workspace: string) => Promise<void>
  publish: (descriptor: ClaudeProfileLaunchDescriptor) => Promise<void>
  /** Removes the pointer so the shell refuses visibly; never throws. */
  withdraw: (target?: ClaudeAccountSelectionTarget) => void | Promise<void>
}

/** Settings remain authoritative; nothing in this class persists a second selection. */
export class ClaudeProfileRoutingService {
  private readonly publishIssues = new Map<string, string>()
  private readonly publishes = new Map<string, number>()
  private readonly latestPublishes = new Map<string, Promise<ClaudeProfileLaunchDescriptor>>()
  private readonly pointerWrites = new Map<string, Promise<unknown>>()
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
  publish(
    target?: ClaudeAccountSelectionTarget,
    provisioning: 'always' | 'if-missing' = 'always'
  ): Promise<ClaudeProfileLaunchDescriptor> {
    const key = publishKey(target)
    const generation = (this.publishes.get(key) ?? 0) + 1
    this.publishes.set(key, generation)
    const published = this.publishGeneration(key, generation, target, provisioning)
    this.latestPublishes.set(key, published)
    return published
  }
  private async publishGeneration(
    key: string,
    generation: number,
    target: ClaudeAccountSelectionTarget | undefined,
    provisioning: 'always' | 'if-missing'
  ): Promise<ClaudeProfileLaunchDescriptor> {
    let descriptor: ClaudeProfileLaunchDescriptor | undefined
    try {
      if (this.owner.refresh) {
        await this.owner.refresh(target)
      }
      descriptor = this.resolve(target)
      if (
        descriptor.profile &&
        (provisioning === 'always' || !this.owner.isProvisioned(descriptor))
      ) {
        await this.provision(descriptor)
      }
      if (this.resolve(target).configHome !== descriptor.configHome) {
        throw new Error('Claude account changed while preparing its profile; retry')
      }
      const captured = descriptor
      const published = await this.mutatePointer(key, generation, () =>
        this.owner.publish(captured)
      )
      if (!published) {
        // Why: a newer publish owns the pointer; it speaks for this caller while it names the same profile.
        const newer = await this.latestPublishes.get(key)
        if (newer?.configHome !== captured.configHome) {
          throw new Error('Claude account changed while preparing its profile; retry')
        }
        return captured
      }
      if (generation === this.publishes.get(key)) {
        this.publishIssues.delete(key)
      }
      return descriptor
    } catch (error) {
      // Why: a pointer left naming the previous account would launch it silently. Only the newest
      // target publish, still naming the current selection, speaks for the pointer.
      if (generation === this.publishes.get(key) && !this.isOvertaken(descriptor)) {
        const message = error instanceof Error ? error.message : String(error)
        this.publishIssues.set(
          key,
          target?.runtime === 'wsl' ? `WSL ${target.wslDistro ?? 'distro'}: ${message}` : message
        )
        try {
          await this.mutatePointer(key, generation, async () => {
            await this.owner.withdraw(target)
          })
        } catch (withdrawError) {
          console.warn('[claude-profile] Pointer withdrawal failed:', withdrawError)
        }
      }
      throw error
    }
  }
  private async mutatePointer(
    key: string,
    generation: number,
    operation: () => Promise<void>
  ): Promise<boolean> {
    const previous = this.pointerWrites.get(key) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(async () => {
        if (generation !== this.publishes.get(key)) {
          return false
        }
        await operation()
        return true
      })
    this.pointerWrites.set(key, next)
    try {
      return await next
    } finally {
      if (this.pointerWrites.get(key) === next) {
        this.pointerWrites.delete(key)
      }
    }
  }
  private isOvertaken(descriptor: ClaudeProfileLaunchDescriptor | undefined): boolean {
    try {
      return (
        descriptor !== undefined &&
        this.resolve(descriptor.target).configHome !== descriptor.configHome
      )
    } catch {
      return false
    }
  }
  /** Ownership refusal stops the caller; a worker fault on an already prepared profile only warns. */
  private async provision(descriptor: ClaudeProfileLaunchDescriptor): Promise<void> {
    const provisioned = this.owner.isProvisioned(descriptor)
    let report: ClaudeProfileSetupReport
    try {
      report = await this.owner.prepare(descriptor)
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
  trust(descriptor: ClaudeProfileLaunchDescriptor, workspace: string): Promise<void> {
    return this.owner.trust?.(descriptor, workspace) ?? Promise.resolve()
  }
  pointerPath(target?: ClaudeAccountSelectionTarget): string {
    return this.owner.pointerPath(target)
  }
  async startup(): Promise<void> {
    let firstError: unknown
    for (const target of this.owner.targets()) {
      try {
        await this.publish(target)
      } catch (error) {
        firstError ??= error
      }
    }
    if (firstError) {
      throw firstError
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
   * A pane's spawn env: its children keep this account until the pane reopens, while the claude
   * function re-reads the pointer. Makes no guest call and never throws, so a non-Claude pane
   * always opens.
   */
  terminalEnv(target?: ClaudeAccountSelectionTarget): ClaudeEnvPatch {
    try {
      return this.envPatch(this.resolve(target))
    } catch {
      return { [CLAUDE_PROFILE_POINTER_ENV]: this.pointerPath(target) }
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
    const issues = this.currentPublishIssues()
    if (this.pointerIsCurrent()) {
      return { ...state, accounts, ...(issues ? { profileRoutingIssue: issues } : {}) }
    }
    this.repair ??= this.publish(undefined, 'if-missing')
      .catch(() => {})
      .finally(() => {
        this.repair = null
      })
    return {
      ...state,
      accounts,
      profileRoutingIssue: issues || 'Claude account selection is being published'
    }
  }
  // Why: a target no longer routed (accounts removed, distro-less shell) has no publish to clear it.
  private currentPublishIssues(): string {
    const routed = new Set(['host', ...this.owner.targets().map(publishKey)])
    return [...this.publishIssues]
      .filter(([key]) => routed.has(key))
      .map(([, issue]) => issue)
      .join('; ')
  }
  private pointerIsCurrent(): boolean {
    try {
      const descriptor = this.resolve()
      return readClaudeProfilePointer(descriptor.pointerPath) === (descriptor.profile?.home ?? null)
    } catch {
      return false
    }
  }
  /** Never throws: skill roots for every provider read this, and only Claude launches may refuse
   *  an unresolvable account; a WSL distro not yet inspected this session reads the legacy home. */
  configDirOr(target: ClaudeAccountSelectionTarget | undefined, legacy: () => string): string {
    try {
      return this.resolve(target).readHome
    } catch {
      return legacy()
    }
  }
  historyRoots(
    target?: ClaudeAccountSelectionTarget,
    surface?: 'projects' | 'transcripts'
  ): string[] {
    return [...new Set(this.owner.readHomes(target, surface))]
  }
}

function publishKey(target?: ClaudeAccountSelectionTarget): string {
  return target?.runtime === 'wsl' ? `wsl:${target.wslDistro?.toLowerCase()}` : 'host'
}
