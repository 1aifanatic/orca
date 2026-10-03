import { existsSync } from 'node:fs'
import {
  createManagedCommandMatcher,
  hookDefinitionHasManagedCommand,
  readHooksJson
} from '../agent-hooks/installer-utils'
import { refreshWslRuntimeUserHooks } from './codex-hook-wsl-runtime'
import {
  createCodexWslRuntimeHookInstallPlan,
  type CodexWslRuntimeHookInstallPlan
} from './codex-wsl-hook-install-plan'
import { resolveWslGuestCodexHomePath } from './codex-wsl-guest-home'
import { runExclusivelyForCodexTrustConfig } from './codex-trust-config-mutation-queue'

export type RunningWslGuest = { distro: string; guestHome: string | null }

// Why injected: this module is in the CLI build, which must not load the WSL probes.
let listRunningWslGuests: () => Promise<RunningWslGuest[]> = async () => []

export function setRunningWslGuestLister(list: () => Promise<RunningWslGuest[]>): void {
  listRunningWslGuests = list
}

/**
 * Pure: no canonical-path probe, since the withdrawal sweeps Orca's guest trust
 * under any path, and probing would spawn wsl.exe once per running distro.
 */
export function createWslGuestCodexHookOptOutPlan({
  distro,
  guestHome
}: RunningWslGuest): CodexWslRuntimeHookInstallPlan | null {
  return createCodexWslRuntimeHookInstallPlan(
    guestHome ? resolveWslGuestCodexHomePath(guestHome, distro) : null,
    { runtime: 'wsl', wslDistro: distro },
    (_distro, linuxPath) => linuxPath
  )
}

async function listRunningGuestCodexHookPlans(): Promise<CodexWslRuntimeHookInstallPlan[]> {
  return (await listRunningWslGuests()).flatMap((guest) => {
    const plan = createWslGuestCodexHookOptOutPlan(guest)
    return plan ? [plan] : []
  })
}

function hasOrcaCodexHookEntry(configPath: string): boolean {
  if (!existsSync(configPath)) {
    return false
  }
  const isManagedCommand = createManagedCommandMatcher('codex-hook.sh')
  return Object.values(readHooksJson(configPath)?.hooks ?? {}).some(
    (definitions) =>
      Array.isArray(definitions) &&
      definitions.some((definition) =>
        hookDefinitionHasManagedCommand(definition, isManagedCommand)
      )
  )
}

/**
 * The opt-out's reach into each running distro's own ~/.codex, which launch
 * prep never strips because other Orcas share it. Stopped distros are not
 * booted for this; Orca stops re-adding the entry there either way.
 */
export async function withdrawWslGuestCodexHooksForOptOut(
  listPlans: () => Promise<CodexWslRuntimeHookInstallPlan[]> = listRunningGuestCodexHookPlans
): Promise<void> {
  for (const plan of await listPlans()) {
    try {
      // Why one lane: checked outside it, an in-flight hooks-on install could add the entry after the check.
      const status = await runExclusivelyForCodexTrustConfig(plan.tomlPath, async () =>
        hasOrcaCodexHookEntry(plan.configPath) ? refreshWslRuntimeUserHooks(plan) : null
      )
      if (status?.state === 'error') {
        console.warn('[codex-hook-service] failed to remove WSL Codex hooks:', status.detail)
      }
    } catch (error) {
      console.warn('[codex-hook-service] failed to remove WSL Codex hooks:', error)
    }
  }
}
