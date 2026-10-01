import { requirePathExistenceResults } from '../../../../shared/path-existence-batch'
import type { NativeChatDraftAttachment } from './native-chat-draft-storage'

/**
 * Ids of attachments whose file is gone. A path that cannot be checked (an unreachable SSH host,
 * or a file outside Orca's roots) is not reported: losing contact is not proof the file is gone.
 */
export async function findMissingNativeChatAttachments(
  attachments: readonly NativeChatDraftAttachment[]
): Promise<Set<string>> {
  const byConnection = new Map<string, NativeChatDraftAttachment[]>()
  for (const attachment of attachments) {
    const connectionId = attachment.connectionId ?? ''
    byConnection.set(connectionId, [...(byConnection.get(connectionId) ?? []), attachment])
  }
  const missing = new Set<string>()
  await Promise.all(
    Array.from(byConnection, async ([connectionId, group]) => {
      try {
        const filePaths = group.map((attachment) => attachment.path)
        const results = requirePathExistenceResults(
          await window.api.fs.pathsExist?.({
            filePaths,
            ...(connectionId ? { connectionId } : {})
          }),
          filePaths.length
        )
        results.forEach((result, index) => {
          if ('exists' in result && !result.exists) {
            missing.add(group[index].id)
          }
        })
      } catch {
        // Unverifiable: keep the chip as it is.
      }
    })
  )
  return missing
}
