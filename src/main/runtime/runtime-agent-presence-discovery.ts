import type { AgentPresenceDiscoveryRequest } from '../agent-hooks/server/server-agent-presence-discovery'
import type { IPtyProvider } from '../providers/types'
import { discoverLocalAgentPresence } from '../providers/agent-presence-discovery'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

export async function discoverRuntimeAgentPresence(args: {
  pty: RuntimePtyWorktreeRecord | undefined
  current(): RuntimePtyWorktreeRecord | undefined
  issueHandle(pty: RuntimePtyWorktreeRecord): string
  provider: (() => IPtyProvider) | null
  admit: ((request: AgentPresenceDiscoveryRequest) => Promise<void>) | null
}): Promise<void> {
  const { pty, admit, provider } = args
  if (
    !pty ||
    !admit ||
    !provider ||
    pty.connectionId ||
    pty.isWsl ||
    (process.platform === 'win32' && pty.isWsl !== false) ||
    !pty.incarnationId ||
    !pty.tabId ||
    !pty.paneKey
  ) {
    return
  }
  const { incarnationId, tabId, paneKey, worktreeId } = pty
  const isCurrent = () =>
    args.current() === pty &&
    pty.incarnationId === incarnationId &&
    pty.paneKey === paneKey &&
    pty.tabId === tabId &&
    pty.worktreeId === worktreeId &&
    !pty.connectionId
  await admit({
    paneKey,
    tabId,
    worktreeId,
    ptyId: pty.ptyId,
    terminalHandle: args.issueHandle(pty),
    isCurrent,
    discover: async () => {
      const inventory = await provider().listProcesses()
      const owned = inventory.find(
        (candidate) => candidate.id === pty.ptyId && candidate.incarnationId === incarnationId
      )
      if (!isCurrent() || !owned?.rootProcessId || owned.wslDistro) {
        return undefined
      }
      return discoverLocalAgentPresence(owned.rootProcessId)
    }
  })
}
