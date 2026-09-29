import { z } from 'zod'

/** Relay request that converges worktrees' entries outside a spawn (removal, setting turned off). */
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

// Why: outside a spawn the relay has no launch env, so a converge carries the keys that name Claude's config file.
const claudeTrustConfigEnvSchema = z.object({
  CLAUDE_CONFIG_DIR: z.string().optional(),
  CLAUDE_CODE_CUSTOM_OAUTH_URL: z.string().optional()
})

export type ClaudeTrustConfigEnv = z.infer<typeof claudeTrustConfigEnvSchema>

/** `claudeTrust.converge` params: every request targets the one config file `env` names. */
export type ClaudeTrustConvergeParams = {
  requests: ClaudeFolderTrustSpawnRequest[]
  env: ClaudeTrustConfigEnv
}

/** Only the config-file keys; anything else, or a malformed value, yields none. */
export function readClaudeTrustConfigEnv(value: unknown): ClaudeTrustConfigEnv {
  const parsed = claudeTrustConfigEnvSchema.safeParse(value)
  return parsed.success ? parsed.data : {}
}

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

/** A malformed entry is dropped alone, so it cannot block the rest of the batch. */
export function parseClaudeTrustConvergeRequests(value: unknown): ClaudeFolderTrustSpawnRequest[] {
  return Array.isArray(value)
    ? value.flatMap((item) => parseClaudeFolderTrustSpawnRequest(item) ?? [])
    : []
}
