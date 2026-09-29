import { z } from 'zod'

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

const claudeFolderTrustSpawnRequestSchema = z.object({
  worktreeRoot: z.string().min(1),
  mainCheckoutPath: z.string().nullable().optional(),
  trusted: z.boolean()
})

export function parseClaudeFolderTrustSpawnRequest(
  value: unknown
): ClaudeFolderTrustSpawnRequest | null {
  const parsed = claudeFolderTrustSpawnRequestSchema.safeParse(value)
  if (!parsed.success) {
    return null
  }
  return {
    worktreeRoot: parsed.data.worktreeRoot,
    mainCheckoutPath: parsed.data.mainCheckoutPath ?? null,
    trusted: parsed.data.trusted
  }
}
