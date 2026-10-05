import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { readHooksJson } from '../agent-hooks/installer-utils'
import { resolveCodexCommand } from '../codex-cli/command'
import {
  computeTrustKey,
  getCodexExplicitHomeHookSourcePath,
  readHookTrustEntries,
  type CodexHookTrustState
} from './config-toml-trust'
import {
  CODEX_EVENTS,
  CODEX_EVENT_LABEL,
  getCodexConfigTomlPath,
  getConfigPath,
  getManagedCommand,
  getManagedScriptPath
} from './codex-hook-definition'
import { readMemoizedCodexHookTrust, type CodexHookTrustAnswer } from './codex-hook-trust-memo'
import {
  getCodexHookReconcileVerdict,
  getCodexRealHomeLaneProblem,
  resolveCodexHookStatusHome
} from './codex-hook-reconcile'
import {
  getRealHomeConfigTomlPath,
  getRealHomeHookKeySourcePaths,
  getRealHomeHooksJsonPath
} from './codex-real-home-hooks-json'
import { describeCodexVersion } from './codex-hook-trust-derivation'

/**
 * Codex hook status for one home, read from its files: Orca's entry in each
 * event Codex lists, and that entry's approval holding Codex's own hash under
 * any spelling Codex may key the file by.
 */
export function getCodexHookStatus(args: {
  hooksJsonPath: string
  tomlPath: string
  /** The paths Codex may key this home's entries by. */
  keySourcePaths: readonly string[]
  command: string
  answer: CodexHookTrustAnswer | null
  rejected?: boolean
}): AgentHookInstallStatus {
  const { hooksJsonPath: configPath, answer } = args
  const status = (
    state: AgentHookInstallState,
    managedHooksPresent: boolean,
    detail: string | null
  ): AgentHookInstallStatus => ({ agent: 'codex', state, configPath, managedHooksPresent, detail })
  const config = readHooksJson(configPath)
  if (!config) {
    return status('error', false, 'Could not parse Codex hooks.json')
  }
  const slots = new Map(
    CODEX_EVENTS.flatMap((eventName) => {
      const definitions = Array.isArray(config.hooks?.[eventName]) ? config.hooks![eventName]! : []
      const slot = definitions.flatMap((definition, groupIndex) =>
        (definition.hooks ?? []).flatMap((hook, handlerIndex) =>
          hook.command === args.command ? [{ groupIndex, handlerIndex }] : []
        )
      )[0]
      return slot ? [[eventName, slot] as const] : []
    })
  )
  if (!answer?.hashes) {
    // Why read the file first: an entry approved earlier still works while Codex is re-asked.
    return slots.size > 0
      ? status(
          'partial',
          true,
          `Orca's hook entry is installed; its approval is not verified yet${answer ? ` (${answer.failure})` : ''}`
        )
      : status('not_installed', false, answer?.failure ?? 'Orca has not asked Codex yet')
  }
  // Why: an unreadable config.toml is distinct from an absent one (an empty map).
  let trustStates: ReadonlyMap<string, CodexHookTrustState>
  let trustReadError: string | null = null
  try {
    trustStates = readHookTrustEntries(args.tomlPath)
  } catch (error) {
    trustStates = new Map()
    trustReadError = error instanceof Error ? error.message : String(error)
  }
  const missing: string[] = []
  const unapproved: string[] = []
  for (const eventName of CODEX_EVENTS) {
    const label = CODEX_EVENT_LABEL[eventName]
    const hash = answer.hashes[label]
    const slot = slots.get(eventName)
    if (!hash) {
      continue
    }
    if (!slot) {
      missing.push(eventName)
      continue
    }
    const approved = args.keySourcePaths.some((sourcePath) => {
      const state = trustStates.get(
        computeTrustKey({ sourcePath, eventLabel: label, command: args.command, ...slot })
      )
      return state?.trustedHash === hash && state.enabled !== false
    })
    if (!approved) {
      unapproved.push(eventName)
    }
  }
  if (
    missing.length ===
    CODEX_EVENTS.filter((event) => answer.hashes[CODEX_EVENT_LABEL[event]]).length
  ) {
    return status(
      'not_installed',
      false,
      trustReadError && `Trust entries unverifiable: ${trustReadError}`
    )
  }
  if (args.rejected) {
    return status(
      'error',
      true,
      `${describeCodexVersion(answer.codexVersion)} did not accept Orca's hook approval`
    )
  }
  const parts = [
    missing.length > 0 ? `Managed hook missing for events: ${missing.join(', ')}` : null,
    trustReadError !== null
      ? `Trust entries unverifiable: ${trustReadError}`
      : unapproved.length > 0
        ? `Approval missing, stale or disabled for events: ${unapproved.join(', ')}`
        : null
  ].filter((part): part is string => part !== null)
  return parts.length === 0
    ? status('installed', true, null)
    : status('partial', true, parts.join('; '))
}

/**
 * Status for `runtimeHomePath`, or for the home the next native pane gets when
 * none is named (~/.codex outside the app). Codex's hashes come from the last
 * reconcile, or the memo.
 */
export function readCurrentCodexHookStatus(runtimeHomePath?: string): AgentHookInstallStatus {
  const reconciled = getCodexHookReconcileVerdict()
  const answer =
    reconciled?.answer ??
    readMemoizedCodexHookTrust(resolveCodexCommand(), getManagedCommand(getManagedScriptPath()))
  if (runtimeHomePath !== undefined) {
    return readCodexHookHomeStatus(runtimeHomePath, answer)
  }
  const home = resolveCodexHookStatusHome()
  if (home.kind === 'unknown') {
    return {
      agent: 'codex',
      state: 'error',
      configPath: getRealHomeHooksJsonPath(),
      managedHooksPresent: false,
      detail: "The selected Codex account's home is not available yet"
    }
  }
  const status = readCodexHookHomeStatus(
    home.kind === 'managed' ? home.path : undefined,
    answer,
    reconciled?.verified === 'rejected'
  )
  const laneProblem = home.kind === 'managed' ? getCodexRealHomeLaneProblem() : null
  // Why say it: panes moved to Orca's own Codex home because ~/.codex could not take the hook.
  return laneProblem
    ? {
        ...status,
        detail: [`${laneProblem}; Orca's panes use Orca's own Codex home`, status.detail]
          .filter(Boolean)
          .join('; ')
      }
    : status
}

/** Status for a managed home, or ~/.codex when `runtimeHomePath` is undefined. */
export function readCodexHookHomeStatus(
  runtimeHomePath: string | undefined,
  answer: CodexHookTrustAnswer | null,
  rejected = false
): AgentHookInstallStatus {
  const command = getManagedCommand(getManagedScriptPath())
  if (runtimeHomePath === undefined) {
    return getCodexHookStatus({
      hooksJsonPath: getRealHomeHooksJsonPath(),
      tomlPath: getRealHomeConfigTomlPath(),
      keySourcePaths: getRealHomeHookKeySourcePaths(),
      command,
      answer,
      rejected
    })
  }
  const hooksJsonPath = getConfigPath(runtimeHomePath)
  return getCodexHookStatus({
    hooksJsonPath,
    tomlPath: getCodexConfigTomlPath(runtimeHomePath),
    keySourcePaths: [getCodexExplicitHomeHookSourcePath(hooksJsonPath)],
    command,
    answer
  })
}
