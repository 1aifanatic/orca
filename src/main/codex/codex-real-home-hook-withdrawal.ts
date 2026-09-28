import {
  readHooksJsonWithRaw,
  writeHooksJson,
  type HookCommandConfig,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import { resolveHooksJsonWritePath } from '../agent-hooks/hook-config-write-path'
import { createCodexHookTrustEntry } from './codex-hook-identity'
import type { RealHomeCodexHookSlotWrite } from './codex-real-home-hook-entry-plan'
import { getRealHomeConfigTomlPath, getRealHomeHooksJsonPath } from './codex-real-home-hooks-json'
import { computeTrustedHash, computeTrustKey, readHookTrustEntries } from './config-toml-trust'

function findHandler(
  definitions: HookDefinition[],
  command: string
): { groupIndex: number; handlerIndex: number } | null {
  for (const [groupIndex, definition] of definitions.entries()) {
    const handlerIndex = (definition.hooks ?? []).findIndex((hook) => hook.command === command)
    if (handlerIndex !== -1) {
      return { groupIndex, handlerIndex }
    }
  }
  return null
}

function withdrawHandler(
  definitions: HookDefinition[],
  location: { groupIndex: number; handlerIndex: number },
  replaced: HookCommandConfig | null
): HookDefinition[] {
  const definition = definitions[location.groupIndex]!
  const hooks = [...definition.hooks!]
  if (replaced) {
    hooks[location.handlerIndex] = replaced
  } else {
    hooks.splice(location.handlerIndex, 1)
  }
  const next = [...definitions]
  if (hooks.length === 0) {
    next.splice(location.groupIndex, 1)
  } else {
    next[location.groupIndex] = { ...definition, hooks }
  }
  return next
}

/**
 * After a failed trust grant: takes back each entry this call wrote that is still
 * untrusted, putting back the handler it replaced. Re-reads both files, so a
 * concurrent edit, or the identical entry another Orca trusted, survives.
 */
export function withdrawUntrustedRealHomeWrites(
  writes: readonly RealHomeCodexHookSlotWrite[],
  command: string
): void {
  if (writes.length === 0) {
    return
  }
  const hooksJsonPath = getRealHomeHooksJsonPath()
  const { config } = readHooksJsonWithRaw(hooksJsonPath)
  if (!config?.hooks) {
    return
  }
  const trustStates = readHookTrustEntries(getRealHomeConfigTomlPath())
  const nextHooks: Record<string, HookDefinition[]> = { ...config.hooks }
  let withdrew = false
  for (const { eventName, replaced } of writes) {
    const definitions = nextHooks[eventName]
    const location = Array.isArray(definitions) ? findHandler(definitions, command) : null
    if (!definitions || !location) {
      continue
    }
    const definition = definitions[location.groupIndex]!
    const entry = createCodexHookTrustEntry(
      hooksJsonPath,
      eventName,
      location.groupIndex,
      location.handlerIndex,
      definition,
      definition.hooks![location.handlerIndex]!
    )
    if (
      entry &&
      trustStates.get(computeTrustKey(entry))?.trustedHash === computeTrustedHash(entry)
    ) {
      continue
    }
    const next = withdrawHandler(definitions, location, replaced)
    if (next.length === 0) {
      delete nextHooks[eventName]
    } else {
      nextHooks[eventName] = next
    }
    withdrew = true
  }
  if (withdrew) {
    writeHooksJson(
      resolveHooksJsonWritePath(hooksJsonPath),
      { ...config, hooks: nextHooks },
      { preserveMode: true }
    )
  }
}
