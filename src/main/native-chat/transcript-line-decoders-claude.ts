// Claude JSONL line → NativeChatMessage decoder.

import {
  NATIVE_CHAT_INTERRUPTED_STATUS_TEXT,
  type NativeChatAskAnswer,
  type NativeChatBlock,
  type NativeChatEditPatch,
  type NativeChatEditPatchHunk,
  type NativeChatMessage,
  type NativeChatToolResultBlock
} from '../../shared/native-chat-types'
import {
  asRecord,
  extractString,
  parseJsonObject,
  timestampMs
} from '../ai-vault/session-scanner-values'
import { imageSourcePathFromText } from '../../shared/native-chat-image-transcript-markers'
import { claudeContentBlocks } from './transcript-record-blocks'
import { claudeInterruptedMessageId } from './transcript-turn-markers'

const MAX_EDIT_PATCH_HUNKS = 40
const MAX_EDIT_PATCH_HUNK_LINES = 400
// Claude asks at most four questions at a time; this only bounds a malformed record.
const MAX_ASK_ANSWERS = 16
// Claude's stand-in answer when the reader typed a note but chose no option.
const CLAUDE_NOTES_ONLY_ANSWER = '(notes only)'

/** Claude reports an edit as a snippet pair on the call, which cannot locate the
 *  change in the file. The result record carries the hunks it resolved against
 *  the real file, so keep them for the renderer's line-number gutter. */
function claudeEditPatch(record: Record<string, unknown>): NativeChatEditPatch | null {
  const result = asRecord(record.toolUseResult)
  const raw = result?.structuredPatch
  if (!Array.isArray(raw) || raw.length === 0) {
    return null
  }
  const hunks: NativeChatEditPatchHunk[] = []
  for (const entry of raw.slice(0, MAX_EDIT_PATCH_HUNKS)) {
    const hunk = asRecord(entry)
    const lines = hunk?.lines
    if (
      typeof hunk?.oldStart !== 'number' ||
      typeof hunk.newStart !== 'number' ||
      !Array.isArray(lines)
    ) {
      continue
    }
    hunks.push({
      oldStart: hunk.oldStart,
      oldLines: typeof hunk.oldLines === 'number' ? hunk.oldLines : 0,
      newStart: hunk.newStart,
      newLines: typeof hunk.newLines === 'number' ? hunk.newLines : 0,
      lines: lines
        .slice(0, MAX_EDIT_PATCH_HUNK_LINES)
        .flatMap((line) => (typeof line === 'string' ? [line] : []))
    })
  }
  if (hunks.length === 0) {
    return null
  }
  const filePath = extractString(result?.filePath)
  return { ...(filePath ? { filePath } : {}), hunks }
}

/** An AskUserQuestion result keeps its answers as data beside the prose it hands
 *  the model, keyed by each question's exact text. The prose varies by release and
 *  quotes answers unescaped, so only the data is read: the chosen labels, then any
 *  note the reader typed. A string answer is kept whole (it may be typed text, or
 *  labels already joined); a list is per label. */
function claudeAskAnswers(record: Record<string, unknown>): NativeChatAskAnswer[] | null {
  const result = asRecord(record.toolUseResult)
  const answers = asRecord(result?.answers)
  if (!answers || !Array.isArray(result?.questions)) {
    return null
  }
  // An idle timeout reports picks never submitted, and a typed response is sent in
  // place of the answers (unless it asks for follow-up questions).
  const response = typeof result.response === 'string' ? result.response.trim() : ''
  if (result.afkTimeoutMs || (response.length > 0 && result.followUp !== true)) {
    return null
  }
  const annotations = asRecord(result.annotations)
  const entries: NativeChatAskAnswer[] = []
  for (const entry of result.questions.slice(0, MAX_ASK_ANSWERS)) {
    const question = asRecord(entry)?.question
    if (typeof question !== 'string' || question.trim().length === 0) {
      continue
    }
    const value = answers[question]
    const notes = asRecord(annotations?.[question])?.notes
    const parts = [...(Array.isArray(value) ? value : [value]), notes].filter(
      (part): part is string =>
        typeof part === 'string' && part.trim().length > 0 && part !== CLAUDE_NOTES_ONLY_ANSWER
    )
    if (parts.length > 0) {
      entries.push({ question, answer: parts })
    }
  }
  return entries.length > 0 ? entries : null
}

/** Attaches data from the result record to its tool result, which is the only
 *  block in a Claude result turn. */
function withResultData(
  blocks: NativeChatBlock[],
  data: Pick<NativeChatToolResultBlock, 'editPatch' | 'askAnswers'>
): NativeChatBlock[] {
  let attached = false
  return blocks.map((block) => {
    if (attached || block.type !== 'tool-result') {
      return block
    }
    attached = true
    return { ...block, ...data }
  })
}

export function decodeClaudeTranscriptLine(
  line: string,
  fallbackId: string
): NativeChatMessage | null {
  const record = parseJsonObject(line)
  if (!record) {
    return null
  }
  const role = record.type
  if (role !== 'user' && role !== 'assistant') {
    return null
  }
  const timestamp = parseTimestamp(record.timestamp)
  const recordMessageId = extractString(record.uuid) ?? fallbackId
  if (claudeInterruptedMessageId(record)) {
    // Why: keep Claude's injected boilerplate out of the user-bubble path while
    // preserving the interruption as a quiet, replayable conversation status.
    return {
      id: recordMessageId,
      role: 'system',
      blocks: [{ type: 'text', text: NATIVE_CHAT_INTERRUPTED_STATUS_TEXT }],
      timestamp,
      source: 'transcript'
    }
  }
  const message = asRecord(record.message)
  const editPatch = claudeEditPatch(record)
  const askAnswers = claudeAskAnswers(record)
  const contentBlocks = claudeContentBlocks(message?.content)
  const decodedBlocks =
    editPatch || askAnswers
      ? withResultData(contentBlocks, {
          ...(editPatch ? { editPatch } : {}),
          ...(askAnswers ? { askAnswers } : {})
        })
      : contentBlocks
  if (decodedBlocks.length === 0) {
    return null
  }
  // Why: Claude structurally marks injected turns, but tool-result records are
  // genuine output and must remain visible even when the containing turn is meta.
  const isInjectedUserTurn =
    role === 'user' &&
    (record.isMeta === true || record.isSynthetic === true || record.isCompactSummary === true)
  // Why image-source text survives the filter: Claude records a pasted image as a
  // companion turn marked `isMeta`, holding one `[Image: source: <path>]` block per
  // image. Dropping it left the prompt turn with no trace of its attachments — the
  // base64 blocks on the prompt itself carry no url/path and are dropped too — so a
  // turn with images rendered with no images at all.
  const blocks = isInjectedUserTurn
    ? isImageSourceRecord(decodedBlocks)
      ? decodedBlocks
      : decodedBlocks.filter((block) => block.type === 'tool-result')
    : decodedBlocks
  if (blocks.length === 0) {
    return null
  }
  const messageId = extractString(record.uuid) ?? extractString(message?.id)
  return {
    id: messageId ?? fallbackId,
    role: claudeMessageRole(role, blocks),
    blocks,
    timestamp,
    source: 'transcript'
  }
}

// Keep only genuine image companion records; a marker mixed with prose must
// remain an injected turn (or be dropped), never become an image-source turn.
function isImageSourceRecord(blocks: NativeChatBlock[]): boolean {
  return (
    blocks.length > 0 &&
    blocks.every((block) => block.type === 'text' && imageSourcePathFromText(block.text) !== null)
  )
}

// Claude marks reasoning via `thinking` content blocks; when a message is made
// up solely of reasoning, surface it as a reasoning-role message.
function claudeMessageRole(
  role: 'user' | 'assistant',
  blocks: NativeChatBlock[]
): NativeChatMessage['role'] {
  if (role === 'user') {
    const onlyToolResults = blocks.every((block) => block.type === 'tool-result')
    return onlyToolResults && blocks.length > 0 ? 'tool' : 'user'
  }
  return role
}

function parseTimestamp(value: unknown): number | null {
  const parsed = timestampMs(value)
  return Number.isFinite(parsed) ? parsed : null
}
