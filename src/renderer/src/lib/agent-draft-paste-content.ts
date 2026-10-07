import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  sendAgentDraftPasteContentToWriter,
  type AgentDraftPtyInputWriter
} from '../../../shared/agent-draft-paste-content'
import { runTerminalPtyInputTransaction } from '@/components/terminal-pane/terminal-pty-input-transaction'
import { sendRuntimePtyInputVerified } from '@/runtime/runtime-terminal-inspection'
import type { TerminalInputKind } from '../../../shared/terminal-input-kind'

export {
  AGENT_DRAFT_PASTE_DIRECT_MAX_BYTES,
  AGENT_DRAFT_PASTE_CHUNK_MAX_BYTES,
  AGENT_DRAFT_PASTE_MAX_BYTES,
  chunkAgentDraftPasteContent,
  iterateAgentDraftPasteContentChunks,
  type AgentDraftPtyInputWriter
} from '../../../shared/agent-draft-paste-content'

export async function sendAgentDraftPasteContent(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  ptyId: string,
  content: string,
  inputKind: TerminalInputKind,
  writePty?: AgentDraftPtyInputWriter
): Promise<boolean> {
  return await runTerminalPtyInputTransaction(ptyId, () =>
    sendAgentDraftPasteContentNow(settings, ptyId, content, inputKind, writePty)
  )
}

// Callers that include Enter in their transaction already hold the lock.
export async function sendAgentDraftPasteContentNow(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  ptyId: string,
  content: string,
  inputKind: TerminalInputKind,
  writePty?: AgentDraftPtyInputWriter
): Promise<boolean> {
  return sendAgentDraftPasteContentToWriter(
    content,
    writePty ?? ((data) => sendRuntimePtyInputVerified(settings, ptyId, data, inputKind))
  )
}
