import {
  createManagedCommandMatcher,
  MANAGED_HOOK_TIMEOUT_SECONDS,
  readHooksJsonWithRaw,
  removeManagedCommands,
  type HookDefinition,
  type HooksConfig
} from '../agent-hooks/installer-utils'
import {
  getRealHomeConfigTomlPath,
  getRealHomeHooksJsonPath,
  reconcileManagedHookDefinition,
  serializeRealHomeHooksJson
} from './codex-real-home-hooks-json'
import { getCodexManagedScriptFileName } from './codex-hook-identity'
import type { CodexManagedTrustGrantPlan } from './codex-hook-trust-grant'
import {
  buildExpectedEntries,
  findLedgerGrant,
  isCodexTrustRpcDisabled
} from './codex-managed-trust-grant-plan'
import { resolveCodexTrustGrantHost } from './codex-trust-grant-host'
import { sharedCodexScriptMatches } from './codex-shared-script-write'
import {
  getCodexManagedHookInstallMaterial,
  type CodexManagedHookInstallMaterial
} from './codex-hook-definition'
import { getSystemCodexHomePath } from './codex-home-paths'
import type { CodexTrustEntry } from './config-toml-trust'

export type RealHomeCodexHookInstallPlan = {
  material: CodexManagedHookInstallMaterial
  hooksJsonPath: string
  previousRaw: string | null
  config: HooksConfig
  nextHooks: Record<string, HookDefinition[]>
  managedEntries: CodexTrustEntry[]
}

/** Reads the real hooks.json and computes Orca's desired entry. Writes nothing. */
export function planRealHomeCodexHookInstall(): RealHomeCodexHookInstallPlan | null {
  const material = getCodexManagedHookInstallMaterial()
  const hooksJsonPath = getRealHomeHooksJsonPath()
  // Why: the generation guard compares against these bytes before writing; a
  // separate later read would let a concurrent save land between parse and
  // snapshot and be silently overwritten by the stale parse.
  const { raw: previousRaw, config } = readHooksJsonWithRaw(hooksJsonPath)
  if (!config) {
    // Why: an unparseable user file must never be clobbered; without a hook
    // entry the managed lane keeps status working for this host.
    console.warn('[codex-real-home-hooks] could not parse', hooksJsonPath, '- managed lane kept')
    return null
  }
  if (Object.keys(config).some((key) => key !== 'hooks')) {
    // Why: Codex rejects unknown root keys instead of ignoring them. Avoid a
    // transient rewrite of a user-owned file that the trust RPC cannot load.
    return null
  }

  const isManagedCommand = createManagedCommandMatcher(getCodexManagedScriptFileName())
  const nextHooks: Record<string, HookDefinition[]> = { ...config.hooks }
  const managedEntries: CodexTrustEntry[] = []
  for (const eventName of material.events) {
    const current = Array.isArray(nextHooks[eventName]) ? nextHooks[eventName] : []
    const reconciled = reconcileManagedHookDefinition(current, isManagedCommand, material.command)
    nextHooks[eventName] = reconciled.definitions
    managedEntries.push({
      sourcePath: hooksJsonPath,
      eventLabel: material.eventLabel[eventName],
      groupIndex: reconciled.groupIndex,
      handlerIndex: reconciled.handlerIndex,
      command: material.command,
      timeoutSec: MANAGED_HOOK_TIMEOUT_SECONDS
    })
  }
  // Why: sweep stale Orca entries out of events the managed lane no longer
  // subscribes to, mirroring the managed installer's upgrade behavior.
  for (const [eventName, definitions] of Object.entries(nextHooks)) {
    if ((material.events as readonly string[]).includes(eventName) || !Array.isArray(definitions)) {
      continue
    }
    const cleaned = removeManagedCommands(definitions, isManagedCommand)
    if (cleaned.length === 0) {
      delete nextHooks[eventName]
    } else {
      nextHooks[eventName] = cleaned
    }
  }
  return { material, hooksJsonPath, previousRaw, config, nextHooks, managedEntries }
}

export function realHomeGrantPlan(plan: RealHomeCodexHookInstallPlan): CodexManagedTrustGrantPlan {
  return {
    runtimeHomePath: getSystemCodexHomePath(),
    tomlPath: getRealHomeConfigTomlPath(),
    managedCommand: plan.material.command,
    managedEntries: plan.managedEntries,
    host: { kind: 'native' },
    telemetryLane: 'real-home',
    useDefaultCodexHome: true
  }
}

/** True when hooks.json, the shared script and the recorded grant already match. Writes nothing. */
export async function isRealHomeCodexHookCurrent(
  plan: RealHomeCodexHookInstallPlan
): Promise<boolean> {
  if (
    // Why: the grant refuses before its ledger check, so a recorded grant is not current here.
    isCodexTrustRpcDisabled() ||
    plan.previousRaw !== serializeRealHomeHooksJson({ ...plan.config, hooks: plan.nextHooks }) ||
    !sharedCodexScriptMatches(plan.material.scriptPath, plan.material.script)
  ) {
    return false
  }
  const grantPlan = realHomeGrantPlan(plan)
  const host = await resolveCodexTrustGrantHost(grantPlan.host)
  return findLedgerGrant(grantPlan, buildExpectedEntries(grantPlan), host.binaryStamp) !== null
}
