import type { OpenCodeWireEvent } from './serve/native-protocol'
import type { OpenCodeSessionCatalog } from './serve/session-catalog'
import type {
  OpenCodeSession,
  OpenCodeStructuredSessionAdapterDeps
} from './opencode-structured-session-state'
import { object, string } from './serve/timeline-shapes'

export function updateOpenCodeContextWindow(session: OpenCodeSession): void {
  if (!session.translator) {
    return
  }
  session.translator.contextWindowTokens =
    session.models.find((model) => model.id === session.options.model)?.contextWindowTokens ?? null
}

export function applyOpenCodeCatalog(
  session: OpenCodeSession,
  catalog: OpenCodeSessionCatalog,
  deps: OpenCodeStructuredSessionAdapterDeps
): void {
  session.models = catalog.models
  session.modes = catalog.modes
  session.commands = catalog.commands
  if (session.client?.version.major === 1) {
    const confirmed = new Set(catalog.current.confirmed ?? [])
    session.options = {
      ...session.options,
      ...(confirmed.has('model') ? { model: catalog.current.model } : {}),
      ...(confirmed.has('effort') ? { effort: catalog.current.effort } : {}),
      ...(confirmed.has('mode') ? { mode: catalog.current.mode } : {}),
      confirmed: [...new Set([...(session.options.confirmed ?? []), ...confirmed])]
    }
  } else {
    session.options = { ...catalog.current }
  }
  if (session.client?.version.major === 2) {
    session.optionValues = {
      model: catalog.current.model,
      ...(catalog.current.effort ? { effort: catalog.current.effort } : {}),
      ...(catalog.current.mode ? { mode: catalog.current.mode } : {})
    }
  }
  updateOpenCodeContextWindow(session)
  try {
    deps.onCatalog?.(session.sessionId, catalog.models)
  } catch (error) {
    deps.logger?.error('OpenCode catalog publication failed', {
      scope: 'opencode-catalog',
      sessionId: session.sessionId,
      error
    })
  }
}

/** Fresh 1.x sessions omit defaults; actual message metadata confirms them. */
export function observeOpenCodeOptions(session: OpenCodeSession, event: OpenCodeWireEvent): void {
  if (!session.root || !session.translator) {
    return
  }
  const info = object(event.data.info) ?? object(event.data.message)
  if (!info || string(info.sessionID) !== session.root.id) {
    return
  }
  const model = object(info.model)
  const provider = string(model?.providerID) ?? string(info.providerID)
  const id = string(model?.modelID) ?? string(model?.id) ?? string(info.modelID)
  const mode = string(info.agent) ?? string(info.mode)
  const variant = string(model?.variant) ?? string(info.variant)
  if (provider && id && `${provider}/${id}`.length <= 512) {
    session.options = {
      ...session.options,
      model: `${provider}/${id}`,
      effort: variant ?? 'default',
      confirmed: [...new Set([...(session.options.confirmed ?? []), 'model', 'effort'])]
    }
    session.optionValues.model = session.options.model
    session.optionValues.effort = variant ?? 'default'
  }
  if (mode && mode.length <= 256) {
    session.options = {
      ...session.options,
      mode,
      confirmed: [...new Set([...(session.options.confirmed ?? []), 'mode'])]
    }
    session.optionValues.mode = mode
  }
  updateOpenCodeContextWindow(session)
}
