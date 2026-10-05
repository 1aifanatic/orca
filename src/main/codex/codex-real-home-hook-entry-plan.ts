import type { HookCommandConfig, HookDefinition } from '../agent-hooks/installer-utils'
import {
  buildCodexManagedHook,
  type CodexManagedHookInstallMaterial
} from './codex-hook-definition'
import { CODEX_HOOK_COMMAND_FORM, readCodexHookCommandForm } from './codex-hook-command-form'
import { createCodexHookTrustEntry } from './codex-hook-identity'
import type { CodexTrustEntry } from './config-toml-trust'

export type RealHomeCodexHookEntryPlan = {
  hooks: Record<string, HookDefinition[]>
  changed: boolean
  /** The frozen entries whose approval this build needs. */
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

type OrcaUnit = { groupIndex: number; handlerIndex: number } | { groupIndex: number; key: string }

function isConvertibleSlot(definition: HookDefinition): boolean {
  return (
    definition.matcher === undefined &&
    !DIRECT_COMMAND_KEYS.some((key) => typeof definition[key] === 'string')
  )
}

function hasCommand(definition: HookDefinition): boolean {
  return (
    DIRECT_COMMAND_KEYS.some((key) => typeof definition[key] === 'string') ||
    (Array.isArray(definition.hooks) && definition.hooks.length > 0)
  )
}

function withoutOrcaUnit(definitions: HookDefinition[], unit: OrcaUnit): HookDefinition[] {
  const definition: HookDefinition = { ...definitions[unit.groupIndex]! }
  if ('key' in unit) {
    delete definition[unit.key]
  } else {
    definition.hooks = definition.hooks!.filter((_, index) => index !== unit.handlerIndex)
    if (definition.hooks.length === 0) {
      delete definition.hooks
    }
  }
  const next = [...definitions]
  if (hasCommand(definition)) {
    next[unit.groupIndex] = definition
  } else {
    next.splice(unit.groupIndex, 1)
  }
  return next
}

function userHandlerPositions(
  definitions: HookDefinition[],
  isOrcaCommand: (command: string | undefined) => boolean
): Map<HookCommandConfig, string> {
  const positions = new Map<HookCommandConfig, string>()
  definitions.forEach((definition, groupIndex) =>
    definition.hooks?.forEach((hook, handlerIndex) => {
      if (!isOrcaCommand(hook.command)) {
        positions.set(hook, `${groupIndex}:${handlerIndex}`)
      }
    })
  )
  return positions
}

function movesUserHandler(
  before: HookDefinition[],
  after: HookDefinition[],
  isOrcaCommand: (command: string | undefined) => boolean
): boolean {
  const afterPositions = userHandlerPositions(after, isOrcaCommand)
  return [...userHandlerPositions(before, isOrcaCommand)].some(
    ([hook, position]) => afterPositions.get(hook) !== position
  )
}

export function planRealHomeCodexHookEntries(args: {
  hooks: Record<string, HookDefinition[]>
  sourcePath: string
  material: CodexManagedHookInstallMaterial
  isOrcaCommand: (command: string | undefined) => boolean
}): RealHomeCodexHookEntryPlan {
  const { material, isOrcaCommand, sourcePath } = args
  const command = material.command
  // Why: events this build does not subscribe to keep their Orca entries; a
  // newer build may subscribe to them.
  const hooks: Record<string, HookDefinition[]> = { ...args.hooks }
  const managedEntries: CodexTrustEntry[] = []
  let changed = false
  // Why every copy: a duplicate kept in place must not be listed for review.
  const trustFrozenEntries = (eventName: string): void => {
    hooks[eventName]!.forEach((definition, groupIndex) =>
      definition.hooks?.forEach((hook, handlerIndex) => {
        const entry =
          hook.command === command
            ? createCodexHookTrustEntry(
                sourcePath,
                eventName,
                groupIndex,
                handlerIndex,
                definition,
                hook
              )
            : null
        if (entry) {
          managedEntries.push(entry)
        }
      })
    )
  }

  for (const eventName of material.events) {
    const current = Array.isArray(hooks[eventName]) ? hooks[eventName] : []
    const handlers = findOrcaHandlers(current, isOrcaCommand, command)
    const directOrcaUnits: OrcaUnit[] = current.flatMap((definition, groupIndex) =>
      DIRECT_COMMAND_KEYS.filter((key) => isOrcaCommand(definition[key])).map((key) => ({
        groupIndex,
        key
      }))
    )
    if (handlers.some((handler) => handler.form > CODEX_HOOK_COMMAND_FORM)) {
      // Why: a newer build owns this event's entry; adding ours would run the hook twice.
      continue
    }
    let definitions = current
    const keeper = handlers.find((handler) => isConvertibleSlot(current[handler.groupIndex]!))
    if (keeper && keeper.hook.command !== command) {
      // Why in place: the slot keeps its position, so no user trust key moves.
      const slot = current[keeper.groupIndex]!
      const slotHooks = [...slot.hooks!]
      slotHooks[keeper.handlerIndex] = buildCodexManagedHook(command, eventName)
      definitions = [...current]
      definitions[keeper.groupIndex] = { ...slot, hooks: slotHooks }
    }
    const others: OrcaUnit[] = [
      ...handlers.filter((handler) => handler !== keeper),
      ...directOrcaUnits
    ]
    others.sort((a, b) =>
      a.groupIndex !== b.groupIndex
        ? b.groupIndex - a.groupIndex
        : ('handlerIndex' in b ? b.handlerIndex : -1) - ('handlerIndex' in a ? a.handlerIndex : -1)
    )
    for (const unit of others) {
      const next = withoutOrcaUnit(definitions, unit)
      // Why: a duplicate before a user hook stays; removing it would move that hook's trust key.
      if (!movesUserHandler(definitions, next, isOrcaCommand)) {
        definitions = next
      }
    }
    if (
      !definitions.some((definition) => definition.hooks?.some((hook) => hook.command === command))
    ) {
      // Why last: no user hook's positional trust key moves.
      definitions = [...definitions, { hooks: [buildCodexManagedHook(command, eventName)] }]
    }
    if (definitions !== current) {
      hooks[eventName] = definitions
      changed = true
    }
    if (hooks[eventName]) {
      trustFrozenEntries(eventName)
    }
  }

  return { hooks, changed, managedEntries }
}
