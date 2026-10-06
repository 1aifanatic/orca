import { join } from 'node:path'
import type { ClaudeProfileRouter } from '../claude-accounts/claude-profile-router'
import { applyClaudeEnvPatch } from '../claude-accounts/environment'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { resolveStructuredClaudeAccountHomePath } from '../runtime/structured-agent-account-home'

/**
 * The folder a structured launch runs under, and the env patch that pins it there.
 * With account routing every launch follows the current selection, as a typed `claude` does.
 */
export async function resolveClaudeStructuredLaunchHome(
  router: ClaudeProfileRouter | undefined,
  env: Record<string, string>,
  recordHome: string
): Promise<string> {
  if (!router) {
    return recordHome
  }
  const launchHome = resolveStructuredClaudeAccountHomePath({
    launchEnv: env,
    wslDistro: null,
    getClaudeConfigDirectory: () => router.systemDefaultHome()
  })
  applyClaudeEnvPatch(env, (await router.prepareLaunch()).envPatch)
  return launchHome
}

/** Whether Claude wrote a transcript for this id under the given config folder. */
export async function claudeTranscriptExists(input: {
  providerSessionId: string
  claudeConfigDir: string
}): Promise<boolean> {
  const path = await resolveSessionFilePath('claude', input.providerSessionId, {
    claudeProjectsDir: join(input.claudeConfigDir, 'projects')
  })
  return path !== null
}
