import { posix } from 'node:path'
import { toWindowsWslUncPath } from '../../shared/wsl-paths'
import { CLAUDE_PROFILE_ROUTING_CAPABILITY } from '../../shared/claude-profile-routing'
import { isAgentStatusHooksEnabledForAgent } from '../../shared/agent-status-hooks-setting'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { describeClaudeProfile } from './claude-profile-paths'
import type { ClaudeProfileRoutingOwner } from './claude-profile-routing-service'
import {
  getSelectedClaudeAccountIdForTarget,
  type ClaudeAccountSelectionTarget
} from './runtime-selection'
import {
  prepareClaudeWslGuest,
  withdrawClaudeWslPointer,
  type ClaudeWslGuest,
  type ClaudeWslProfileResponse
} from './claude-profile-wsl-transport'

export type ClaudeProfileSettings = Pick<
  GlobalSettings,
  | 'claudeManagedAccounts'
  | 'activeClaudeManagedAccountId'
  | 'activeClaudeManagedAccountIdsByRuntime'
  | 'agentStatusHooksEnabled'
  | 'disabledTuiAgents'
>

export function createWslClaudeProfileOwner(
  settings: () => ClaudeProfileSettings,
  prepareGuest: (distro: string) => Promise<ClaudeWslGuest> = prepareClaudeWslGuest,
  withdrawPointer: (distro: string) => Promise<void> = withdrawClaudeWslPointer
): ClaudeProfileRoutingOwner {
  const guests = new Map<string, { guest: ClaudeWslGuest; expires: number }>()
  const inspections = new Map<
    string,
    { accountId: string | null; result: ClaudeWslProfileResponse }
  >()
  const distroFor = (target?: ClaudeAccountSelectionTarget) => {
    const distro = target?.wslDistro?.trim()
    if (!distro) {
      throw new Error('Claude profile requires a specific WSL distro')
    }
    return (
      settings().claudeManagedAccounts.find(
        (account) => account.wslDistro?.toLowerCase() === distro.toLowerCase()
      )?.wslDistro ?? distro
    )
  }
  const selected = (target?: ClaudeAccountSelectionTarget) => {
    const distro = distroFor(target)
    const accountId = getSelectedClaudeAccountIdForTarget(settings(), {
      runtime: 'wsl',
      wslDistro: distro
    })
    const account = settings().claudeManagedAccounts.find((entry) => entry.id === accountId)
    if (
      accountId &&
      (!account ||
        account.managedAuthRuntime !== 'wsl' ||
        account.wslDistro?.toLowerCase() !== distro.toLowerCase())
    ) {
      throw new Error('Claude account does not belong to this WSL distro')
    }
    return { distro, accountId }
  }
  const guestFor = (distro: string) => {
    const guest = guests.get(distro.toLowerCase())
    if (!guest) {
      throw new Error(`WSL distro ${distro} has not provided its Claude profile paths`)
    }
    return guest.guest
  }
  const owner: ClaudeProfileRoutingOwner = {
    refresh: async (target) => {
      const { distro, accountId } = selected(target)
      const cached = guests.get(distro.toLowerCase())
      const guest =
        cached && cached.expires > Date.now() ? cached.guest : await prepareGuest(distro)
      if (guest !== cached?.guest) {
        guests.set(distro.toLowerCase(), { guest, expires: Date.now() + 600_000 })
      }
      const result = await guest.request({
        action: 'inspect',
        distro,
        accountId,
        userHome: guest.home,
        hooksEnabled: false
      })
      inspections.set(distro.toLowerCase(), { accountId, result })
      if (!result.ready) {
        throw new Error('Selected WSL Claude account needs a fresh sign-in')
      }
    },
    resolve(target) {
      const { distro, accountId } = selected(target)
      const guest = guestFor(distro)
      const inspected = inspections.get(distro.toLowerCase())
      if (inspected?.accountId !== accountId || !inspected.result.ready) {
        throw new Error('WSL Claude profile is not verified')
      }
      const dataRoot = posix.join(guest.home, '.local/share/orca')
      const profile = accountId
        ? describeClaudeProfile(dataRoot, accountId, {
            executionHostId: 'local',
            runtime: 'wsl',
            distro
          })
        : null
      const defaultHome = posix.join(guest.home, '.claude')
      return {
        profile,
        configHome: profile?.home ?? defaultHome,
        readHome: toWindowsWslUncPath(profile?.home ?? defaultHome, distro),
        defaultHome,
        pointerPath: owner.pointerPath(target),
        target: { runtime: 'wsl', wslDistro: distro }
      }
    },
    pointerPath: (target) =>
      posix.join(
        guestFor(distroFor(target)).home,
        '.local/share/orca/claude-profiles/selected-wsl'
      ),
    targets: () =>
      [
        ...new Set(
          settings().claudeManagedAccounts.flatMap((account) =>
            account.managedAuthRuntime === 'wsl' && account.wslDistro ? [account.wslDistro] : []
          )
        )
      ].map((wslDistro) => ({ runtime: 'wsl', wslDistro })),
    capabilities: () => [CLAUDE_PROFILE_ROUTING_CAPABILITY],
    readHomes: (target, surface) => {
      if (target) {
        const distro = distroFor(target)
        const inspected = inspections.get(distro.toLowerCase())?.result
        return ((surface ? inspected?.historyHomes?.[surface] : inspected?.homes) ?? []).map(
          (home) => toWindowsWslUncPath(home, distro)
        )
      }
      return owner.targets().flatMap((entry) => owner.readHomes(entry, surface))
    },
    isProvisioned: ({ target }) =>
      inspections.get(distroFor(target).toLowerCase())?.result.provisioned ?? false,
    readiness: (accountId) => {
      const account = settings().claudeManagedAccounts.find((entry) => entry.id === accountId)
      const inspection = account?.wslDistro
        ? inspections.get(account.wslDistro.toLowerCase())
        : undefined
      return inspection?.accountId === accountId && inspection.result.ready
        ? 'ready'
        : 'sign-in-required'
    },
    prepare: async (descriptor) => {
      const distro = distroFor(descriptor.target)
      const guest = guestFor(distro)
      const result = await guest.request({
        action: 'setup',
        distro,
        userHome: guest.home,
        accountId: descriptor.profile?.accountId ?? null,
        hooksEnabled: isAgentStatusHooksEnabledForAgent(settings(), 'claude')
      })
      if (!result.report) {
        throw new Error('WSL profile helper did not report setup')
      }
      inspections.set(distro.toLowerCase(), {
        accountId: descriptor.profile?.accountId ?? null,
        result: {
          ...result,
          homes: inspections.get(distro.toLowerCase())?.result.homes,
          historyHomes: inspections.get(distro.toLowerCase())?.result.historyHomes
        }
      })
      return result.report
    },
    trust: async ({ target, profile }, workspacePath) => {
      const distro = distroFor(target)
      const guest = guestFor(distro)
      await guest.request({
        action: 'trust',
        distro,
        userHome: guest.home,
        accountId: profile?.accountId ?? null,
        hooksEnabled: false,
        workspacePath
      })
    },
    publish: async ({ target, profile }) => {
      const distro = distroFor(target)
      const guest = guestFor(distro)
      await guest.request({
        action: 'publish',
        distro,
        userHome: guest.home,
        accountId: profile?.accountId ?? null,
        hooksEnabled: false
      })
    },
    withdraw: async (target) => {
      const distro = distroFor(target)
      guests.delete(distro.toLowerCase())
      inspections.delete(distro.toLowerCase())
      await withdrawPointer(distro)
    }
  }
  return owner
}

export function withWslClaudeProfileOwner(
  native: ClaudeProfileRoutingOwner,
  wsl: ClaudeProfileRoutingOwner,
  settings: () => ClaudeProfileSettings
): ClaudeProfileRoutingOwner {
  const forTarget = (target?: ClaudeAccountSelectionTarget) =>
    target?.runtime === 'wsl' ? wsl : native
  return {
    refresh: (target) => forTarget(target).refresh?.(target) ?? Promise.resolve(),
    resolve: (target) => forTarget(target).resolve(target),
    pointerPath: (target) => forTarget(target).pointerPath(target),
    targets: () => [...native.targets(), ...wsl.targets()],
    readHomes: (target, surface) =>
      target
        ? forTarget(target).readHomes(target, surface)
        : [...native.readHomes(undefined, surface), ...wsl.readHomes(undefined, surface)],
    capabilities: (target) => forTarget(target).capabilities(target),
    isProvisioned: (descriptor) => forTarget(descriptor.target).isProvisioned(descriptor),
    readiness: (id) =>
      (settings().claudeManagedAccounts.find((account) => account.id === id)?.managedAuthRuntime ===
      'wsl'
        ? wsl
        : native
      ).readiness(id),
    prepare: (descriptor) => forTarget(descriptor.target).prepare(descriptor),
    trust: (descriptor, workspace) =>
      forTarget(descriptor.target).trust?.(descriptor, workspace) ?? Promise.resolve(),
    publish: (descriptor) => forTarget(descriptor.target).publish(descriptor),
    withdraw: (target) => forTarget(target).withdraw(target)
  }
}
