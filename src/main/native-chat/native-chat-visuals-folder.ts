// Where a structured chat's visuals live on the host that owns the chat: Orca-owned state beside the
// chat journal, never inside the user's workspace.

import { join } from 'node:path'
import { journalPathSegment } from './agent-session-journal/journal-paths'

const NATIVE_CHAT_VISUALS_DIR_NAME = 'native-chat-visuals'

/**
 * `<stateDirectory>/native-chat-visuals/<hashed session id>`. Keyed by the session id alone, the
 * chat record's primary key, so the folder needs no workspace lookup to find or remove.
 */
export function nativeChatVisualsFolderFor(stateDirectory: string, sessionId: string): string {
  return join(stateDirectory, NATIVE_CHAT_VISUALS_DIR_NAME, journalPathSegment(sessionId))
}
