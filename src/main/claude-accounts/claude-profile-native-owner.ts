import { readClaudeProfileReadiness, readClaudeProfileOwnership } from './claude-profile-readiness'
import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { GlobalSettings } from '../../shared/global-settings-types'
import {
  CLAUDE_INJECTED_CONFIG_DIR_ENV,
  CLAUDE_PROFILE_ROUTING_CAPABILITY
} from '../../shared/claude-profile-routing'
import { isAgentStatusHooksEnabledForAgent } from '../../shared/agent-status-hooks-setting'
import { describeClaudeProfile, assertClaudeProfileDescendant } from './claude-profile-paths'
import { getSelectedClaudeAccountIdForTarget } from './runtime-selection'
import { publishClaudeProfilePointer, withdrawClaudeProfilePointer } from './claude-profile-pointer'
import type { ClaudeProfileRoutingOwner } from './claude-profile-routing-owner'
import { withWslClaudeProfileOwner } from './claude-profile-wsl-owner'
import { ClaudeProfileRoutingService } from './claude-profile-routing-service'
import { ClaudeProfileSetupWorker } from './claude-profile-worker'

/** The legacy resolver's home, except a value an outer Orca injected (its twin still marks it). */
export function systemDefaultClaudeHome(env: NodeJS.ProcessEnv, userHome: string): string {
  const inherited = env.CLAUDE_CONFIG_DIR?.trim()
  return inherited && inherited !== env[CLAUDE_INJECTED_CONFIG_DIR_ENV]?.trim()
    ? inherited
    : join(userHome, '.claude')
}

/** An owning runtime uses its own settings and paths, including when a paired client calls it. */
export function createNativeClaudeProfileRouting(args: {
  store: {
    getSettings: () => Pick<
      GlobalSettings,
      | 'claudeManagedAccounts'
      | 'activeClaudeManagedAccountId'
      | 'activeClaudeManagedAccountIdsByRuntime'
      | 'agentStatusHooksEnabled'
      | 'disabledTuiAgents'
    >
  }
  dataRoot: string
  userHome: string
  /** System Default's home: the inherited CLAUDE_CONFIG_DIR when set, as the legacy resolver reads it. */
  defaultHome: () => string
  claudeVersion: () => Promise<string | null>
  wsl?: ClaudeProfileRoutingOwner
  worker?: Pick<ClaudeProfileSetupWorker, 'prepare'>
}): ClaudeProfileRoutingService {
  const worker = args.worker ?? new ClaudeProfileSetupWorker()
  const pointerPath = join(args.dataRoot, 'claude-profiles', 'selected-host')
  const profileFor = (id: string) => {
    const profile = describeClaudeProfile(args.dataRoot, id, {
      executionHostId: 'local',
      runtime: 'host'
    })
    assertClaudeProfileDescendant(args.dataRoot, profile.home)
    const readiness = readClaudeProfileReadiness(args.dataRoot, profile)
    if (readiness !== 'ready') {
      throw new Error(
        readiness === 'sign-in-required'
          ? 'Sign in again to use this account.'
          : 'Claude profile is unavailable. Try again.'
      )
    }
    return profile
  }
  const accountFor = (id: string) =>
    args.store.getSettings().claudeManagedAccounts.find((entry) => entry.id === id)
  const native: ClaudeProfileRoutingOwner = {
    resolve(target = { runtime: 'host' }) {
      if (target.runtime === 'wsl') {
        throw new Error(
          'WSL Claude profiles are not supported until guest provisioning is available'
        )
      }
      const id = getSelectedClaudeAccountIdForTarget(args.store.getSettings(), target)
      const account = id ? accountFor(id) : null
      if (id && (!account || account.managedAuthRuntime === 'wsl')) {
        throw new Error('Selected Claude account is unavailable on this host')
      }
      const profile = id ? profileFor(id) : null
      const defaultHome = args.defaultHome()
      return {
        profile,
        configHome: profile?.home ?? defaultHome,
        readHome: profile?.home ?? defaultHome,
        defaultHome,
        pointerPath,
        target
      }
    },
    pointerPath: () => pointerPath,
    targets: () => [{ runtime: 'host' }],
    capabilities: () => [CLAUDE_PROFILE_ROUTING_CAPABILITY],
    readHomes: () => {
      // Why ~/.claude too: step-1 setup pools every profile's history there, whatever System Default is.
      const shared = [args.defaultHome(), join(args.userHome, '.claude')]
      let ids: string[]
      try {
        ids = readdirSync(join(args.dataRoot, 'claude-profiles'))
      } catch {
        return shared
      }
      return [
        ...shared,
        ...ids.flatMap((id) => {
          try {
            const profile = describeClaudeProfile(args.dataRoot, id, {
              executionHostId: 'local',
              runtime: 'host'
            })
            return readClaudeProfileOwnership(args.dataRoot, profile) === 'ready'
              ? [profile.home]
              : []
          } catch {
            return []
          }
        })
      ]
    },
    // Why `projects`: setup always leaves it (shared link or private tree) after writing the marker.
    isProvisioned: ({ profile }) => {
      try {
        return profile !== null && Boolean(lstatSync(join(profile.home, 'projects')))
      } catch {
        return false
      }
    },
    accountHome: (id) => profileFor(id).home,
    readiness: (id) => {
      const account = accountFor(id)
      if (!account || account.managedAuthRuntime === 'wsl') {
        return 'unsupported'
      }
      return readClaudeProfileReadiness(
        args.dataRoot,
        describeClaudeProfile(args.dataRoot, id, { executionHostId: 'local', runtime: 'host' })
      )
    },
    prepare: async (descriptor) => {
      if (!descriptor.profile) {
        throw new Error('System Default does not require profile setup')
      }
      return worker.prepare({
        dataRoot: args.dataRoot,
        userHome: args.userHome,
        profile: descriptor.profile,
        hooksEnabled: isAgentStatusHooksEnabledForAgent(args.store.getSettings(), 'claude'),
        claudeVersion: (await args.claudeVersion()) ?? undefined
      })
    },
    publish: async (descriptor) =>
      publishClaudeProfilePointer(descriptor.pointerPath, descriptor.profile?.home ?? null),
    withdraw: () => withdrawClaudeProfilePointer(pointerPath)
  }
  return new ClaudeProfileRoutingService(
    args.wsl ? withWslClaudeProfileOwner(native, args.wsl, () => args.store.getSettings()) : native
  )
}
