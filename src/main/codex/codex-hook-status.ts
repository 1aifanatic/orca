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
import { getCodexHookReconcileVerdict, resolveCodexHookStatusHome } from './codex-hook-reconcile'
import { getRealHomeConfigTomlPath, getRealHomeHooksJsonPath } from './codex-real-home-hooks-json'
import { getRealHomeHookKeySourcePath } from './codex-real-home-hook-install'

/**
 * Codex hook status for one home, read from its files: Orca's entry in each
 * event Codex lists, and that entry's approval holding Codex's own hash.
 */
export function getCodexHookStatus(args: {
  hooksJsonPath: string
  tomlPath: string
  /** The path Codex keys this home's entries by. */
  keySourcePath: string
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
  if (!answer?.hashes) {
    return status(
      'not_installed',
      false,
      answer?.failure ?? 'Orca has not asked Codex for its hook approval yet'
    )
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
  let present = 0
  for (const eventName of CODEX_EVENTS) {
    const label = CODEX_EVENT_LABEL[eventName]
    const hash = answer.hashes[label]
    if (!hash) {
      continue
    }
    const definitions = Array.isArray(config.hooks?.[eventName]) ? config.hooks![eventName]! : []
    const slot = definitions.flatMap((definition, groupIndex) =>
      (definition.hooks ?? []).flatMap((hook, handlerIndex) =>
        hook.command === args.command ? [{ groupIndex, handlerIndex }] : []
      )
    )[0]
    if (!slot) {
      missing.push(eventName)
      continue
    }
    present += 1
    const state = trustStates.get(
      computeTrustKey({
        sourcePath: args.keySourcePath,
        eventLabel: label,
        command: args.command,
        ...slot
      })
    )
    if (state?.trustedHash !== hash || state.enabled === false) {
      unapproved.push(eventName)
    }
  }
  if (present === 0) {
    return status(
      'not_installed',
      false,
      trustReadError && `Trust entries unverifiable: ${trustReadError}`
    )
  }
  if (args.rejected) {
    return status('error', true, `Codex ${answer.codexVersion} did not accept Orca's hook approval`)
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
  return readCodexHookHomeStatus(
    home.kind === 'managed' ? home.path : undefined,
    answer,
    reconciled?.verified === 'rejected'
  )
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
      keySourcePath: getRealHomeHookKeySourcePath(),
      command,
      answer,
      rejected
    })
  }
  const hooksJsonPath = getConfigPath(runtimeHomePath)
  return getCodexHookStatus({
    hooksJsonPath,
    tomlPath: getCodexConfigTomlPath(runtimeHomePath),
    keySourcePath: getCodexExplicitHomeHookSourcePath(hooksJsonPath),
    command,
    answer
  })
}
