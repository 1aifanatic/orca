import {
  AGENT_SESSION_ATTACHMENT_CHUNK_BASE64_CHARS,
  agentSessionPastedImageName,
  type AgentSessionAttachmentClipboardTarget,
  type AgentSessionAttachmentUploadCommitResult
} from '../../../../shared/agent-session-attachments'
import { callRuntimeResult } from './web-runtime-calls'
import { createBrowserUuid } from '@/lib/browser-uuid'

const ATTACHMENT_CALL_TIMEOUT_MS = 30_000

/** The browser client's paste into a structured chat: the same store the desktop client uses. */
export async function saveClipboardImageAsWebAgentSessionAttachment(
  contentBase64: string,
  target: AgentSessionAttachmentClipboardTarget
): Promise<string> {
  const padding = contentBase64.endsWith('==') ? 2 : contentBase64.endsWith('=') ? 1 : 0
  const byteLength = (contentBase64.length / 4) * 3 - padding
  const { uploadId } = await callRuntimeResult<{ uploadId: string }>(
    'agentSessionAttachment.uploadStart',
    {
      sessionId: target.sessionId,
      name: agentSessionPastedImageName(Date.now(), createBrowserUuid()),
      byteLength
    },
    ATTACHMENT_CALL_TIMEOUT_MS
  )
  try {
    // Chunks are a multiple of 4 base64 characters, so each starts on a byte boundary.
    for (
      let charOffset = 0;
      charOffset < Math.max(contentBase64.length, 1);
      charOffset += AGENT_SESSION_ATTACHMENT_CHUNK_BASE64_CHARS
    ) {
      await callRuntimeResult(
        'agentSessionAttachment.uploadAppend',
        {
          uploadId,
          offset: (charOffset / 4) * 3,
          contentBase64: contentBase64.slice(
            charOffset,
            charOffset + AGENT_SESSION_ATTACHMENT_CHUNK_BASE64_CHARS
          )
        },
        ATTACHMENT_CALL_TIMEOUT_MS
      )
    }
    const stored = await callRuntimeResult<AgentSessionAttachmentUploadCommitResult>(
      'agentSessionAttachment.uploadCommit',
      { uploadId },
      ATTACHMENT_CALL_TIMEOUT_MS
    )
    return stored.path
  } catch (error) {
    await callRuntimeResult(
      'agentSessionAttachment.uploadAbort',
      { uploadId },
      ATTACHMENT_CALL_TIMEOUT_MS
    ).catch(() => {})
    throw error
  }
}
