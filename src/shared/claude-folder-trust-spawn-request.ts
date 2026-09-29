import { z } from 'zod'

/**
 * Optional `pty.spawn` field: the workspace the relay should mark trusted in Claude's
 * config before launching Claude there. Old relays ignore it, so Claude just asks.
 */
export type ClaudeFolderTrustSpawnRequest = {
  workspacePath: string
}

const claudeFolderTrustSpawnRequestSchema = z.object({
  workspacePath: z.string().min(1)
})

export function parseClaudeFolderTrustSpawnRequest(
  value: unknown
): ClaudeFolderTrustSpawnRequest | null {
  const parsed = claudeFolderTrustSpawnRequestSchema.safeParse(value)
  return parsed.success ? { workspacePath: parsed.data.workspacePath } : null
}
