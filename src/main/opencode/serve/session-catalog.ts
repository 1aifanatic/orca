import type {
  AgentSessionModelOption,
  AgentSessionOptionsResult,
  AgentSessionOptionChoice,
  AgentSessionSlashCommand
} from '../../../shared/agent-session-wire'
import { OpenCodeHttpError } from './http-response'
import { openCodeObjectSchema, type OpenCodeModel } from './native-protocol'
import { openCodeCatalogModels } from './catalog-models'
import type { OpenCodeSessionClient } from './session-client'

export type OpenCodeSessionCatalog = {
  models: AgentSessionModelOption[]
  commands: AgentSessionSlashCommand[]
  modes: AgentSessionOptionChoice[]
  current: AgentSessionOptionsResult['current'] & { mode?: string }
}

export function openCodeSelectedModel(
  options: Readonly<Record<string, string>>
): OpenCodeModel | undefined {
  const value = options.model
  if (!value || value === 'default') {
    return undefined
  }
  const separator = value.indexOf('/')
  if (separator < 1 || separator === value.length - 1) {
    throw new Error('OpenCode model must name its provider and model')
  }
  const variant = options.effort
  return {
    providerID: value.slice(0, separator),
    id: value.slice(separator + 1),
    ...(variant && variant !== 'default' ? { variant } : {})
  }
}

function rows(value: unknown, major: 1 | 2): unknown[] {
  const result = openCodeObjectSchema.safeParse(value)
  const data = major === 1 ? value : result.success ? result.data.data : null
  if (!Array.isArray(data)) {
    throw new OpenCodeHttpError('invalid-response', 'OpenCode sent an unreadable catalog')
  }
  return data.slice(0, 2_000)
}

export async function readOpenCodeSessionCatalog(
  client: OpenCodeSessionClient,
  sessionId?: string
): Promise<OpenCodeSessionCatalog> {
  const major = client.version.major
  const query = new URLSearchParams({
    [major === 1 ? 'directory' : 'location[directory]']: client.directory
  })
  const [modelData, commandData, agentData, session] = await Promise.all([
    client.peer.json(`${client.path(major === 1 ? '/config/providers' : '/model')}?${query}`),
    client.peer.json(`${client.path('/command')}?${query}`),
    client.peer.json(`${client.path('/agent')}?${query}`),
    sessionId ? client.load(sessionId) : undefined
  ])
  const models = openCodeCatalogModels(modelData, major)
  const model = session?.model
  const currentModel = model ? `${model.providerID}/${model.id}` : 'default'
  const commands = rows(commandData, major).flatMap((value): AgentSessionSlashCommand[] => {
    const row = openCodeObjectSchema.safeParse(value)
    if (!row.success || typeof row.data.name !== 'string' || row.data.name.length > 256) {
      return []
    }
    return [
      {
        name: row.data.name,
        kind: 'command',
        kindUnspecified: true,
        ...(typeof row.data.description === 'string'
          ? { description: row.data.description.slice(0, 4096) }
          : {})
      }
    ]
  })
  const modes = rows(agentData, major).flatMap((value): AgentSessionOptionChoice[] => {
    const row = openCodeObjectSchema.safeParse(value)
    if (!row.success || row.data.hidden === true || row.data.mode === 'subagent') {
      return []
    }
    const id = major === 1 ? row.data.name : row.data.id
    if (typeof id !== 'string' || id.length > 256) {
      return []
    }
    return [
      {
        value: id,
        label: (typeof row.data.name === 'string' ? row.data.name : id).slice(0, 512),
        ...(typeof row.data.description === 'string'
          ? { description: row.data.description.slice(0, 4096) }
          : {})
      }
    ]
  })
  return {
    models: models.map((row) => ({ ...row, isDefault: row.id === currentModel })),
    commands,
    modes,
    current: {
      model: currentModel,
      ...(model ? { effort: model.variant ?? 'default' } : {}),
      ...(session?.agent ? { mode: session.agent } : {}),
      confirmed: [...(model ? ['model', 'effort'] : []), ...(session?.agent ? ['mode'] : [])]
    }
  }
}

export async function setOpenCodeSessionOption(
  client: OpenCodeSessionClient,
  sessionId: string,
  key: string,
  value: string,
  options: Readonly<Record<string, string>>
): Promise<Record<string, string>> {
  const catalog = await readOpenCodeSessionCatalog(client, sessionId)
  const next = { ...options, [key]: value }
  if (key === 'mode') {
    if (!catalog.modes.some((mode) => mode.value === value)) {
      throw new Error('OpenCode mode is unavailable')
    }
  } else if (key === 'model' || key === 'effort') {
    const model = catalog.models.find((model) => model.id === next.model)
    if (next.model !== 'default' && !model) {
      throw new Error('OpenCode model is unavailable')
    }
    if (key === 'effort' && !model?.efforts.some((effort) => effort.value === value)) {
      throw new Error('OpenCode model variant is unavailable')
    }
    if (
      key === 'model' &&
      next.effort &&
      !model?.efforts.some((effort) => effort.value === next.effort)
    ) {
      delete next.effort
    }
  } else {
    throw new Error('OpenCode option is unavailable')
  }
  if (client.version.major === 1) {
    return next
  }
  const selected = openCodeSelectedModel(next)
  if (key !== 'mode' && !selected) {
    throw new Error('Select an OpenCode model first')
  }
  await client.peer.json(client.sessionPath(sessionId, key === 'mode' ? '/agent' : '/model'), {
    method: 'POST',
    body: key === 'mode' ? { agent: value } : { model: selected }
  })
  const reported = await client.load(sessionId)
  if (
    key === 'mode'
      ? reported.agent !== value
      : reported.model?.providerID !== selected?.providerID ||
        reported.model?.id !== selected?.id ||
        (reported.model?.variant ?? 'default') !== (selected?.variant ?? 'default')
  ) {
    throw new Error('OpenCode did not confirm the selected option')
  }
  if (key !== 'mode') {
    next.effort = reported.model?.variant ?? 'default'
  }
  return next
}
