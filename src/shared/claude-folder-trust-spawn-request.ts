/** Relay request that converges one worktree's entry outside a spawn (worktree removal). */
export const CLAUDE_TRUST_CONVERGE_METHOD = 'claudeTrust.converge'

/**
 * Optional `pty.spawn` field: the desired Claude folder-trust state for the worktree
 * the relay is about to launch Claude in. Old relays ignore it, so Claude just asks.
 */
export type ClaudeFolderTrustSpawnRequest = {
  worktreeRoot: string
  mainCheckoutPath: string | null
  trusted: boolean
}

export function parseClaudeFolderTrustSpawnRequest(
  value: unknown
): ClaudeFolderTrustSpawnRequest | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const worktreeRoot = Reflect.get(value, 'worktreeRoot')
  const mainCheckoutPath = Reflect.get(value, 'mainCheckoutPath')
  const trusted = Reflect.get(value, 'trusted')
  if (typeof worktreeRoot !== 'string' || !worktreeRoot || typeof trusted !== 'boolean') {
    return null
  }
  return {
    worktreeRoot,
    mainCheckoutPath: typeof mainCheckoutPath === 'string' ? mainCheckoutPath : null,
    trusted
  }
}
