import {
  buildManagedCommandHook,
  removeManagedCommands,
  type HookCommandConfig,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import type { CodexManagedHookInstallMaterial } from './codex-hook-definition'
import { CODEX_HOOK_COMMAND_FORM, readCodexHookCommandForm } from './codex-hook-command-form'
import { createCodexHookTrustEntry } from './codex-hook-identity'
import type { CodexTrustEntry } from './config-toml-trust'

/**
 * - 'add-missing-only' (every launch): adds Orca's entry to an event that has
 *   none, and leaves every Orca entry it finds as it is.
 * - 'convert-older-forms' (app start): also rewrites an older Orca form to the
 *   frozen command once, and collapses duplicates.
 */
export type RealHomeCodexHookWritePolicy = 'add-missing-only' | 'convert-older-forms'

export type RealHomeCodexHookSlotWrite = {
  eventName: string
  /** The handler this call replaced in its slot, or null when it appended a group. */
  replaced: HookCommandConfig | null
}

export type RealHomeCodexHookEntryPlan = {
  hooks: Record<string, HookDefinition[]>
  changed: boolean
  writes: RealHomeCodexHookSlotWrite[]
  /** The frozen entries whose trust this build needs. */
  managedEntries: CodexTrustEntry[]
}

type OrcaHandler = {
  groupIndex: number
  handlerIndex: number
  hook: HookCommandConfig
  form: number
}

const DIRECT_COMMAND_KEYS = ['command', 'bash', 'powershell'] as const

function findOrcaHandlers(
  definitions: HookDefinition[],
  isOrcaCommand: (command: string | undefined) => boolean,
  command: string
): OrcaHandler[] {
  return definitions.flatMap((definition, groupIndex) =>
    Array.isArray(definition.hooks)
      ? definition.hooks.flatMap((hook, handlerIndex) =>
          isOrcaCommand(hook.command)
            ? [
                {
                  groupIndex,
                  handlerIndex,
                  hook,
                  form: readCodexHookCommandForm(hook.command, command)
                }
              ]
            : []
        )
      : []
  )
}

export function planRealHomeCodexHookEntries(args: {
  hooks: Record<string, HookDefinition[]>
  sourcePath: string
  material: CodexManagedHookInstallMaterial
  isOrcaCommand: (command: string | undefined) => boolean
  policy: RealHomeCodexHookWritePolicy
}): RealHomeCodexHookEntryPlan {
  const { material, isOrcaCommand, sourcePath } = args
  const command = material.command
  // Why: events this build does not subscribe to keep their Orca entries; a
  // newer build may subscribe to them.
  const hooks: Record<string, HookDefinition[]> = { ...args.hooks }
  const writes: RealHomeCodexHookSlotWrite[] = []
  const managedEntries: CodexTrustEntry[] = []
  const trustEntryAt = (eventName: string, groupIndex: number, handlerIndex: number): void => {
    const definition = hooks[eventName]![groupIndex]!
    const entry = createCodexHookTrustEntry(
      sourcePath,
      eventName,
      groupIndex,
      handlerIndex,
      definition,
      definition.hooks![handlerIndex]!
    )
    if (entry) {
      managedEntries.push(entry)
    }
  }
  const append = (eventName: string, definitions: HookDefinition[]): void => {
    // Why last: no user hook's positional trust key moves.
    hooks[eventName] = [...definitions, { hooks: [buildManagedCommandHook(command)] }]
    writes.push({ eventName, replaced: null })
    trustEntryAt(eventName, definitions.length, 0)
  }

  for (const eventName of material.events) {
    const current = Array.isArray(hooks[eventName]) ? hooks[eventName] : []
    const handlers = findOrcaHandlers(current, isOrcaCommand, command)
    const hasDirectOrcaCommand = current.some((definition) =>
      DIRECT_COMMAND_KEYS.some((key) => isOrcaCommand(definition[key]))
    )
    if (handlers.length === 0 && !hasDirectOrcaCommand) {
      append(eventName, current)
      continue
    }
    if (handlers.some((handler) => handler.form > CODEX_HOOK_COMMAND_FORM)) {
      // Why: a newer build owns this event's entry; adding ours would run the hook twice.
      continue
    }
    const frozen = handlers.find((handler) => handler.hook.command === command)
    const onlyFrozen = frozen !== undefined && handlers.length === 1 && !hasDirectOrcaCommand
    if (args.policy === 'add-missing-only' || onlyFrozen) {
      // Why: an older build's entry still runs the shared script; converting it
      // is app start's job, so launches never fight a running older build.
      if (frozen) {
        trustEntryAt(eventName, frozen.groupIndex, frozen.handlerIndex)
      }
      continue
    }
    const only = handlers.length === 1 && !hasDirectOrcaCommand ? handlers[0] : undefined
    const slot = only ? current[only.groupIndex] : undefined
    if (
      only &&
      slot &&
      slot.matcher === undefined &&
      !DIRECT_COMMAND_KEYS.some((key) => typeof slot[key] === 'string')
    ) {
      // Why in place: the slot keeps its position, so no user trust key moves.
      const slotHooks = [...slot.hooks!]
      slotHooks[only.handlerIndex] = buildManagedCommandHook(command)
      const definitions = [...current]
      definitions[only.groupIndex] = { ...slot, hooks: slotHooks }
      hooks[eventName] = definitions
      writes.push({ eventName, replaced: only.hook })
      trustEntryAt(eventName, only.groupIndex, only.handlerIndex)
      continue
    }
    append(eventName, removeManagedCommands(current, isOrcaCommand))
  }

  return { hooks, changed: writes.length > 0, writes, managedEntries }
}
