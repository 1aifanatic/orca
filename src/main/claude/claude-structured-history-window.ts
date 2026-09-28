// Provider history for restart reconciliation, read from the Claude project JSONL.
//
// Why this file is the source of truth for "did Claude take it": a resume replays
// this transcript by session id, so a message absent from it is absent from the
// conversation Orca is about to resume. Absence here is not an inference about a
// dead child — it is the content of the next turn's context.
//
// The window is anchored on the leaf uuid Orca durably recorded for the session
// and walks back to it from the file's last transcript row, which is where a
// resume by session id continues; Claude's marker lags a crash mid-turn.
// Without that anchor the read has no proven start, and the branch proof is what
// decides whether the file we just read still descends from it: a fork, a
// compaction, a sibling branch, or a torn tail all fail the proof, and every one
// of those makes absence meaningless. Failing it reports an inconsistent
// boundary rather than an empty window, because the two decide opposite things.

import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import type {
  ProviderHistoryItem,
  ProviderHistorySource,
  ProviderHistoryWindow,
  ProviderRecordedHistory
} from '../native-chat/agent-session-journal/journal-submission-reconciler'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../shared/agent-session-journal-item-key'
import { splitTranscriptStreamLines } from '../native-chat/transcript-stream-lines'
import { claudeContentBlocks } from '../native-chat/transcript-record-blocks'
import { isKnownHarnessInjectedUserTurnText } from '../../shared/harness-injected-user-turns'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import {
  replayClaudeTranscriptBranchAncestry,
  replayClaudeTranscriptBranchAncestryFromJsonl
} from './claude-transcript-branch-proof'

/** The legacy-import bound, now applied PER RECORD rather than per file. The
 *  line framer buffers one record at a time, so this is the only thing standing
 *  between a pathological row and the whole file being resident. */
const MAX_HISTORY_WINDOW_RECORD_BYTES = 16 * 1024 * 1024

const INCONSISTENT: ProviderHistoryWindow = {
  items: [],
  boundaryConsistent: false,
  turnInFlight: false
}

type TranscriptRecord = Record<string, unknown>

function stringField(source: unknown, key: string): string | null {
  if (!source || typeof source !== 'object') {
    return null
  }
  const value = (source as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() ? value : null
}

function isPlainTextPart(part: unknown): boolean {
  if (typeof part === 'string') {
    return true
  }
  return Boolean(part) && typeof part === 'object' && (part as TranscriptRecord).type === 'text'
}

/** Recover the text bytes Claude received; the shared decoder trims for display. */
function rawTextParts(content: unknown): string[] | null {
  if (typeof content === 'string') {
    return content.trim() ? [content] : []
  }
  if (!Array.isArray(content)) {
    return []
  }
  const parts: string[] = []
  for (const part of content) {
    if (typeof part === 'string') {
      if (part.trim()) {
        parts.push(part)
      }
      continue
    }
    const record = part && typeof part === 'object' ? (part as TranscriptRecord) : null
    if (!record || record.type !== 'text' || typeof record.text !== 'string') {
      return null
    }
    if (record.text.trim()) {
      parts.push(record.text)
    }
  }
  return parts
}

/**
 * A plain-text user record Orca could itself have submitted. Rows the harness
 * marks as its own are excluded, because a fingerprint computed over machinery
 * would claim a history slot the user's message should have had.
 *
 * Attachments are excluded too, and deliberately: the transcript keeps a pasted
 * image as base64 with no path, so the `image-ref` block the submission was
 * fingerprinted from cannot be reconstructed. Measured over 2,764 genuine prompt
 * records in 12 local transcripts, every multi-block prompt was exactly
 * text + image; none carried injected content.
 */
function claudePromptBlocks(record: TranscriptRecord): NativeChatBlock[] | null {
  if (
    record.type !== 'user' ||
    record.isSidechain === true ||
    record.parent_tool_use_id != null ||
    record.isMeta === true ||
    record.isSynthetic === true ||
    record.isCompactSummary === true
  ) {
    return null
  }
  const message = record.message
  const content =
    message && typeof message === 'object' ? (message as TranscriptRecord).content : undefined
  // Read the RAW parts, not the decoded ones: a base64 image decodes to nothing
  // at all, so a prompt with an attachment would otherwise pass as text-only and
  // be fingerprinted as if the attachment had never been sent.
  if (Array.isArray(content) && !content.every((part) => isPlainTextPart(part))) {
    return null
  }
  const blocks = claudeContentBlocks(content)
  if (blocks.length === 0 || blocks.some((block) => block.type !== 'text')) {
    return null
  }
  const rawTexts = rawTextParts(content)
  if (rawTexts === null || rawTexts.length !== blocks.length) {
    return null
  }
  return blocks.map((block, index) => ({ ...block, text: rawTexts[index]! }))
}

/** The anchored window's prompts: harness-shaped text is left out, so machinery cannot claim a
 *  send by content. A send handed over under an id never reaches this filter. */
function claudeUserPromptBlocks(record: TranscriptRecord): NativeChatBlock[] | null {
  const blocks = claudePromptBlocks(record)
  const [first] = blocks ?? []
  return first?.type === 'text' && !isKnownHarnessInjectedUserTurnText(first.text) ? blocks : null
}

/**
 * The digest the submission row is GUARANTEED to carry. `admitAndRunAgentSessionMutation`
 * recomputes this exact call over the send's own body and refuses the send on a
 * mismatch, and `performSend` is the only writer of a submission row — so the
 * stored fingerprint is this function's output over the stored body, whoever
 * produced the envelope. Matching here is therefore an equality between two runs
 * of one function, not a guess about two encodings agreeing.
 */
function promptFingerprint(sessionId: string, blocks: NativeChatBlock[]): string {
  return computeAgentSessionPayloadFingerprint({
    method: 'agentSession.send',
    sessionId,
    fields: { body: { kind: 'message', role: 'user', blocks } }
  })
}

type HistoryWindowInput = {
  providerSessionId: string
  previousLeafUuid: string | null
  /** Orca session id: the fingerprint a submission carries is scoped to it. */
  sessionId: string
  /** The caller must PROVE no provider child can be appending; absence proves
   *  nothing while a turn is running. */
  turnInFlight: boolean
}

type HistoryReadInput = HistoryWindowInput & { transcriptPath: string }

/**
 * Sink for the ancestry replay. Only the fingerprinted item survives the call,
 * so the window holds at most one small row per anchor..leaf record — never the
 * prompt bodies it was computed from.
 */
function createWindowCollector(input: HistoryWindowInput) {
  const byUuid = new Map<string, ProviderHistoryItem>()
  return { byUuid, onAncestorRecord }

  function onAncestorRecord(record: TranscriptRecord, uuid: string): void {
    const blocks = claudeUserPromptBlocks(record)
    if (!blocks) {
      return
    }
    byUuid.set(uuid, {
      providerItemId: uuid,
      // Claude echoes no client message id, so identity matching reduces to the
      // fingerprint pass; the reconciler treats that as the weakest evidence.
      clientMessageId: null,
      payloadFingerprint: promptFingerprint(input.sessionId, blocks),
      identity: {
        provider: 'claude',
        sessionId: stringField(record, 'sessionId') ?? input.providerSessionId,
        uuid
      }
    })
  }
}

/**
 * Every user record in the file, wherever it sits: a send handed over under an id is found by
 * that id, so no anchor is needed. Absence counts only when every line of this session's file
 * was read; any line that does not parse may be the missing record.
 */
function createRecordedCollector(input: HistoryWindowInput) {
  const itemIds = new Set<string>()
  const itemIdsByFingerprint = new Map<string, string[]>()
  let whole = true
  return { add, finish }

  function add(line: string): void {
    if (!line.trim()) {
      return
    }
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      whole = false
      return
    }
    const uuid = stringField(record, 'uuid')
    if (!uuid || !record || typeof record !== 'object' || Array.isArray(record)) {
      return
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: A non-array object, checked above.
    const row = record as TranscriptRecord
    if (row.type !== 'user') {
      return
    }
    const sessionId = stringField(row, 'sessionId') ?? input.providerSessionId
    const itemId = agentJournalItemKey({ provider: 'claude', sessionId, uuid })
    itemIds.add(itemId)
    const blocks = claudePromptBlocks(row)
    if (blocks) {
      const fingerprint = promptFingerprint(input.sessionId, blocks)
      const sameText = itemIdsByFingerprint.get(fingerprint) ?? []
      itemIdsByFingerprint.set(fingerprint, [...sameText, itemId])
    }
  }

  function finish(): ProviderRecordedHistory {
    return {
      itemIds,
      itemIdsByFingerprint,
      provesAbsenceOf: (itemId) => {
        const identity = whole ? parseAgentJournalItemKey(itemId) : null
        return identity?.provider === 'claude' && identity.sessionId === input.providerSessionId
      }
    }
  }
}

/** The chain is leaf first; a history window is oldest first. */
function windowFromChain(
  chain: readonly string[],
  byUuid: Map<string, ProviderHistoryItem>,
  turnInFlight: boolean
): ProviderHistoryWindow {
  const items: ProviderHistoryItem[] = []
  for (const uuid of chain.toReversed()) {
    const item = byUuid.get(uuid)
    if (item) {
      items.push(item)
    }
  }
  return { items, boundaryConsistent: true, turnInFlight }
}

export function claudeProviderHistoryWindowFromJsonl(
  input: HistoryWindowInput & { contents: string }
): ProviderHistoryWindow {
  const recorded = createRecordedCollector(input)
  for (const line of input.contents.split('\n')) {
    recorded.add(line)
  }
  return { ...anchoredWindowFromJsonl(input), recorded: recorded.finish() }
}

function anchoredWindowFromJsonl(
  input: HistoryWindowInput & { contents: string }
): ProviderHistoryWindow {
  const ancestryAnchorUuid = input.previousLeafUuid
  if (!ancestryAnchorUuid) {
    return INCONSISTENT
  }
  const collector = createWindowCollector(input)
  try {
    const { chain } = replayClaudeTranscriptBranchAncestryFromJsonl({
      contents: input.contents,
      providerSessionId: input.providerSessionId,
      previousLeafUuid: ancestryAnchorUuid,
      ancestryAnchorUuid,
      onAncestorRecord: collector.onAncestorRecord
    })
    return windowFromChain(chain, collector.byUuid, input.turnInFlight)
  } catch {
    // Every failure mode here — missing ancestor, sibling branch, compacted
    // cursor, torn tail — is a boundary we cannot vouch for.
    return INCONSISTENT
  }
}

/**
 * History for one attached session. Liveness is sampled now, because only the adapter's session
 * map can answer it and a live child means a send queued behind its running turn is not in the file
 * yet. The transcript is resolved and read only when a stranded send needs it.
 */
export function openClaudeProviderHistory(input: {
  identity: AgentSessionJournalIdentity
  accountHomePath: string
  hasLiveSession: boolean
}): ProviderHistorySource | null {
  const handle = input.identity.providerHandle
  if (handle.kind !== 'claude') {
    return null
  }
  const scope: HistoryWindowInput = {
    providerSessionId: handle.sessionId,
    previousLeafUuid: handle.leafUuid,
    sessionId: input.identity.sessionId,
    turnInFlight: input.hasLiveSession
  }
  let transcriptPath: Promise<string | null> | undefined
  const readWith = async <T>(read: (input: HistoryReadInput) => Promise<T>, fallback: T) => {
    const path = await (transcriptPath ??= resolveSessionFilePath('claude', handle.sessionId, {
      claudeProjectsDir: join(input.accountHomePath, 'projects')
    }))
    return path ? read({ ...scope, transcriptPath: path }) : fallback
  }
  return {
    turnInFlight: input.hasLiveSession,
    readWindow: () => readWith(readClaudeProviderHistoryWindow, INCONSISTENT),
    readRecorded: () => readWith(readClaudeRecordedHistory, null)
  }
}

async function readClaudeRecordedHistory(
  input: HistoryReadInput
): Promise<ProviderRecordedHistory | null> {
  const recorded = createRecordedCollector(input)
  try {
    const stream = createReadStream(input.transcriptPath)
    for await (const { line } of splitTranscriptStreamLines(
      stream,
      MAX_HISTORY_WINDOW_RECORD_BYTES
    )) {
      recorded.add(line)
    }
  } catch (error) {
    console.warn('[claude-history-window] transcript unreadable; sends stay unconfirmed:', {
      transcriptPath: input.transcriptPath,
      sessionId: input.sessionId,
      error
    })
    return null
  }
  return recorded.finish()
}

export async function readClaudeProviderHistoryWindow(
  input: HistoryReadInput
): Promise<ProviderHistoryWindow> {
  const ancestryAnchorUuid = input.previousLeafUuid
  if (!ancestryAnchorUuid) {
    return INCONSISTENT
  }
  const collector = createWindowCollector(input)
  try {
    const { chain } = await replayClaudeTranscriptBranchAncestry({
      transcriptPath: input.transcriptPath,
      providerSessionId: input.providerSessionId,
      previousLeafUuid: ancestryAnchorUuid,
      ancestryAnchorUuid,
      maxRecordBytes: MAX_HISTORY_WINDOW_RECORD_BYTES,
      onAncestorRecord: collector.onAncestorRecord
    })
    return windowFromChain(chain, collector.byUuid, input.turnInFlight)
  } catch (error) {
    // Unreadable, unprovable, or a single record too large to frame: all of them
    // leave the boundary unvouched for, which is not the same as an empty window.
    // Oversize is no longer among them, so only the log separates what is left.
    console.warn('[claude-history-window] transcript unprovable; boundary inconsistent:', {
      transcriptPath: input.transcriptPath,
      sessionId: input.sessionId,
      error
    })
    return INCONSISTENT
  }
}
