import type { CodexStructuredLaunch } from './codex-structured-session-state'
import { CODEX_SPAWN_TOKEN_ENV } from './codex-structured-owner-identity'
import { structuredSessionChildIdentityEnv } from '../runtime/structured-session-child-identity-env'
import { withNativeChatVisualsEnv } from '../native-chat/native-chat-visuals-delivery'

export function buildCodexStructuredChildEnvironment(
  launch: CodexStructuredLaunch,
  spawnToken: string,
  sessionId: string
): Record<string, string> {
  return {
    // Every structured session speaks orchestration as itself: its injected id and the Orca CLI.
    ...structuredSessionChildIdentityEnv(
      sessionId,
      withNativeChatVisualsEnv(
        {
          ...launch.env,
          ...(launch.codexHome ? { CODEX_HOME: launch.codexHome } : {})
        },
        launch.visuals ?? null
      )
    ),
    [CODEX_SPAWN_TOKEN_ENV]: spawnToken
  }
}
