import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionSlashCommand } from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'

/** What a provider's `/` surface depends on: the host and workspace it runs in, its account, and
 *  how it was launched. Two chats with the same launch get the same commands. */
function launchKey(record: AgentSessionRecord): string {
  const { location, accountHome } = record
  return JSON.stringify([
    record.provider,
    location.executionHostId,
    location.wslDistro,
    location.workspaceKind,
    location.workspaceId,
    accountHome.variable,
    accountHome.path,
    record.launchArgs ?? []
  ])
}

/**
 * The `/` surface a running agent reports, kept in memory per launch so a chat whose agent is not
 * running (never started after a /clear, or stopped by the idle sweep) still offers the same
 * commands. Only ever a list some agent reported: nothing until one has, and the latest wins.
 */
export class StructuredAgentSessionCommandMemory {
  private readonly lastReported = new Map<string, AgentSessionSlashCommand[]>()

  constructor(
    private readonly deps: () => Pick<StructuredAgentSessionHostDeps, 'adapter' | 'store'>
  ) {}

  read = (sessionId: string): AgentSessionSlashCommand[] | undefined => {
    const { adapter, store } = this.deps()
    const live = adapter.readCommands?.(sessionId)
    const record = store.getRecord(sessionId)
    if (!record) {
      return live
    }
    const key = launchKey(record)
    if (live === undefined) {
      return this.lastReported.get(key)
    }
    this.lastReported.set(key, live)
    return live
  }
}
