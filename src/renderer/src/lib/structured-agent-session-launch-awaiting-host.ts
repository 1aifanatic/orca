import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'

// Why: a launch owns its workspace's first surface while its host decides, before any launch
// record exists; a first-terminal seeder landing in that wait would put a shell beside the chat.
// In memory only, and each hold ends when its ask settles.
const holdCountByPair = new Map<string, number>()

function pairKey(worktreeId: string, agent: AgentSessionHandleProvider): string {
  return `${worktreeId}\u0000${agent}`
}

/** Marks a launch as waiting on its host; the returned release is idempotent. */
export function holdStructuredLaunchAwaitingHost(
  worktreeId: string,
  agent: AgentSessionHandleProvider
): () => void {
  const key = pairKey(worktreeId, agent)
  holdCountByPair.set(key, (holdCountByPair.get(key) ?? 0) + 1)
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    const remaining = (holdCountByPair.get(key) ?? 1) - 1
    if (remaining > 0) {
      holdCountByPair.set(key, remaining)
    } else {
      holdCountByPair.delete(key)
    }
  }
}

export function isStructuredLaunchAwaitingHost(
  worktreeId: string,
  agent: AgentSessionHandleProvider
): boolean {
  return holdCountByPair.has(pairKey(worktreeId, agent))
}
