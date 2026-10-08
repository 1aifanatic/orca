import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'

export function admitOrcadAutomaticStop(commit: () => boolean): boolean {
  return getStructuredAgentSessionHost()?.serverRetirement.admitStop(commit) ?? false
}

export async function prepareOrcadStructuredWorkBoundary(runtime: {
  ensureStructuredAgentSessionHost: () => Promise<void>
}): Promise<void> {
  try {
    await runtime.ensureStructuredAgentSessionHost()
    const host = getStructuredAgentSessionHost()
    await host?.reconcileRestartLeases()
    await host?.serverRetirement.observe()
  } catch (error) {
    console.error('[orcad] structured work is unverifiable:', error)
  }
}

/** An unknown prior owner is probed again; its saved lease never becomes an idle-exit latch. */
export async function observeOrcadStructuredWork(): Promise<number | null> {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return null
  }
  await host.reconcileRestartLeases()
  return host.serverRetirement.observe()
}

export async function expireOrcadUnansweredPrompts(): Promise<number | null> {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return null
  }
  await host.serverRetirement.expireUnansweredPrompts()
  return observeOrcadStructuredWork()
}
