import { lstatSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { CLAUDE_PROFILE_ROUTING_CAPABILITY } from '../../shared/claude-profile-routing'
import { isAgentStatusHooksEnabledForAgent } from '../../shared/agent-status-hooks-setting'
import {
  describeClaudeProfile,
  assertClaudeProfileDescendant,
  readClaudeProfileObject
} from './claude-profile-paths'
import { getSelectedClaudeAccountIdForTarget } from './runtime-selection'
import { publishClaudeProfilePointer } from './claude-profile-pointer'
import { ClaudeProfileRoutingService } from './claude-profile-routing-service'
import { ClaudeProfileSetupWorker } from './claude-profile-worker'

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
  claudeVersion: () => Promise<string | null>
  worker?: Pick<ClaudeProfileSetupWorker, 'prepare'>
}): ClaudeProfileRoutingService {
  const worker = args.worker ?? new ClaudeProfileSetupWorker()
  const profileFor = (id: string) => {
    const profile = describeClaudeProfile(args.dataRoot, id, {
      executionHostId: 'local',
      runtime: 'host'
    })
    assertClaudeProfileDescendant(args.dataRoot, profile.home)
    const markerPath = join(dirname(profile.home), 'profile.json')
    const marker = readClaudeProfileObject(markerPath)
    if (
      marker.kind !== 'present' ||
      marker.value.version !== 1 ||
      marker.value.accountId !== id ||
      marker.value.runtime !== 'host' ||
      marker.value.distro !== undefined ||
      !lstatSync(markerPath).isFile() ||
      !lstatSync(profile.home).isDirectory()
    ) {
      throw new Error('Selected Claude account needs a fresh sign-in')
    }
    return profile
  }
  return new ClaudeProfileRoutingService({
    resolve(target = { runtime: 'host' }) {
      if (target.runtime === 'wsl') {
        throw new Error(
          'WSL Claude profiles are not supported until guest provisioning is available'
        )
      }
      const settings = args.store.getSettings()
      const id = getSelectedClaudeAccountIdForTarget(settings, target)
      const account = id ? settings.claudeManagedAccounts.find((entry) => entry.id === id) : null
      if (id && (!account || account.managedAuthRuntime === 'wsl')) {
        throw new Error('Selected Claude account is unavailable on this host')
      }
      const profile = id ? profileFor(id) : null
      const defaultHome = join(args.userHome, '.claude')
      return {
        profile,
        configHome: profile?.home ?? defaultHome,
        readHome: profile?.home ?? defaultHome,
        defaultHome,
        pointerPath: join(args.dataRoot, 'claude-profiles', 'selected-host'),
        target
      }
    },
    pointerPath: () => join(args.dataRoot, 'claude-profiles', 'selected-host'),
    targets: () => [{ runtime: 'host' }],
    capabilities: () => [CLAUDE_PROFILE_ROUTING_CAPABILITY],
    readHomes: () => {
      let ids: string[]
      try {
        ids = readdirSync(join(args.dataRoot, 'claude-profiles'))
      } catch {
        return [join(args.userHome, '.claude')]
      }
      return [
        join(args.userHome, '.claude'),
        ...ids.flatMap((id) => {
          try {
            return [profileFor(id).home]
          } catch {
            return []
          }
        })
      ]
    },
    prepare: async (descriptor, trustKeys) => {
      if (!descriptor.profile) {
        throw new Error('System Default does not require profile setup')
      }
      return worker.prepare({
        dataRoot: args.dataRoot,
        userHome: args.userHome,
        profile: descriptor.profile,
        hooksEnabled: isAgentStatusHooksEnabledForAgent(args.store.getSettings(), 'claude'),
        claudeVersion: (await args.claudeVersion()) ?? undefined,
        trustKeys
      })
    },
    publish: async (descriptor) =>
      publishClaudeProfilePointer(descriptor.pointerPath, descriptor.profile?.home ?? null)
  })
}
