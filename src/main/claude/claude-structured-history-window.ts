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

import { join } from 'node:path'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import type {
  ProviderHistoryItem,
  ProviderHistorySample,
  ProviderHistoryWindow
} from '../native-chat/agent-session-journal/journal-submission-reconciler'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../shared/agent-session-journal-item-key'
import { claudeContentBlocks } from '../native-chat/transcript-record-blocks'
import { isKnownHarnessInjectedUserTurnText } from '../../shared/harness-injected-user-turns'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import {
  createClaudeBranchAncestryPass,
  pinClaudeTranscript,
  readPinnedClaudeTranscript,
  type ClaudeTranscriptSnapshot
} from './claude-transcript-branch-proof'

/** The legacy-import bound, now applied PER RECORD rather than per file. The
 *  line framer buffers one record at a time, so this is the only thing standing
 *  between a pathological row and the whole file being resident. */
const MAX_HISTORY_WINDOW_RECORD_BYTES = 16 * 1024 * 1024

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

/**
 * Every consumer of one transcript read, each line parsed once:
 *
 * - The anchored window. The branch proof runs over every line, and each prompt
 *   is kept as one small fingerprinted row under the first line carrying its
 *   uuid; once the proof has named the chain, the window is those rows on it.
 * - The recorded history: every user record in the file, wherever it sits. A
 *   send handed over under an id is found by that id, so no anchor is needed.
 *   Absence counts only when every line of this session's file was read; any
 *   line that does not parse may be the missing record.
 */
function createClaudeHistoryPass(
  input: HistoryWindowInput,
  onUnprovable: (error: unknown) => void = () => {}
) {
  const anchorUuid = input.previousLeafUuid
  const branch = anchorUuid
    ? createClaudeBranchAncestryPass({
        providerSessionId: input.providerSessionId,
        previousLeafUuid: anchorUuid,
        ancestryAnchorUuid: anchorUuid
      })
    : null
  const prompts = new Map<string, ProviderHistoryItem>()
  const itemIds = new Set<string>()
  const itemIdsByFingerprint = new Map<string, string[]>()
  let whole = true
  let lineIndex = 0
  return { add, finish }

  function add(line: string, terminated: boolean): void {
    const index = lineIndex++
    if (!line.trim()) {
      return
    }
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      whole = false
      branch?.reject(terminated)
      return
    }
    const firstSeenUuid = branch?.add(record, index) ?? null
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
    if (!blocks) {
      return
    }
    const payloadFingerprint = promptFingerprint(input.sessionId, blocks)
    const sameContent = itemIdsByFingerprint.get(payloadFingerprint)
    if (sameContent) {
      sameContent.push(itemId)
    } else {
      itemIdsByFingerprint.set(payloadFingerprint, [itemId])
    }
    // Harness-shaped text is left out of the window, so machinery cannot claim a
    // send by content. A send handed over under an id never reaches this filter.
    const [first] = blocks
    if (
      firstSeenUuid &&
      first?.type === 'text' &&
      !isKnownHarnessInjectedUserTurnText(first.text)
    ) {
      prompts.set(firstSeenUuid, {
        providerItemId: firstSeenUuid,
        // Claude echoes no client message id, so identity matching reduces to the
        // fingerprint pass; the reconciler treats that as the weakest evidence.
        clientMessageId: null,
        payloadFingerprint,
        identity: { provider: 'claude', sessionId, uuid: firstSeenUuid }
      })
    }
  }

  function finish(): ProviderHistoryWindow {
    const provable = whole
    return {
      ...anchoredWindow(),
      recorded: {
        itemIds,
        itemIdsByFingerprint,
        provesAbsenceOf: (itemId) => {
          const identity = provable ? parseAgentJournalItemKey(itemId) : null
          return identity?.provider === 'claude' && identity.sessionId === input.providerSessionId
        }
      }
    }
  }

  function anchoredWindow(): ProviderHistoryWindow {
    if (!branch) {
      return inconsistent(input)
    }
    let chain: string[]
    try {
      chain = branch.finish().chain
    } catch (error) {
      // Every failure mode here — missing ancestor, sibling branch, compacted
      // cursor, torn tail — is a boundary we cannot vouch for.
      onUnprovable(error)
      return inconsistent(input)
    }
    // The chain is leaf first; a history window is oldest first.
    const items = chain.toReversed().flatMap((uuid) => prompts.get(uuid) ?? [])
    return { items, boundaryConsistent: true, turnInFlight: input.turnInFlight }
  }
}

/** Unvouched-for is not empty; a running turn stays a running turn either way. */
function inconsistent(input: HistoryWindowInput): ProviderHistoryWindow {
  return { items: [], boundaryConsistent: false, turnInFlight: input.turnInFlight }
}

export function claudeProviderHistoryWindowFromJsonl(
  input: HistoryWindowInput & { contents: string }
): ProviderHistoryWindow {
  const pass = createClaudeHistoryPass(input)
  const lines = input.contents.split('\n')
  for (const [index, line] of lines.entries()) {
    pass.add(line, index < lines.length - 1)
  }
  return pass.finish()
}

/**
 * Sample one attached session's history: resolve the provider's transcript and
 * pin its size, and nothing more. A live child means a send queued behind its
 * running turn is not in the file yet, so liveness is carried in rather than
 * assumed — only the adapter's session map can answer it, and only before a
 * new child joins that map. Parsing waits for `read`, over the pinned bytes.
 */
export async function sampleClaudeProviderHistory(input: {
  identity: AgentSessionJournalIdentity
  accountHomePath: string
  hasLiveSession: boolean
}): Promise<ProviderHistorySample | null> {
  const handle = input.identity.providerHandle
  if (handle.kind !== 'claude') {
    return null
  }
  const transcriptPath = await resolveSessionFilePath('claude', handle.sessionId, {
    claudeProjectsDir: join(input.accountHomePath, 'projects')
  })
  if (!transcriptPath) {
    return null
  }
  const snapshot = await pinClaudeTranscript(transcriptPath)
  const read: HistoryWindowInput = {
    providerSessionId: handle.sessionId,
    previousLeafUuid: handle.leafUuid,
    sessionId: input.identity.sessionId,
    turnInFlight: input.hasLiveSession
  }
  return { read: () => readClaudeProviderHistory(snapshot, read) }
}

/** One pass over the pinned transcript serves the window and the recorded history alike. */
export async function readClaudeProviderHistory(
  snapshot: ClaudeTranscriptSnapshot,
  input: HistoryWindowInput
): Promise<ProviderHistoryWindow> {
  const context = { transcriptPath: snapshot.transcriptPath, sessionId: input.sessionId }
  const pass = createClaudeHistoryPass(input, (error) =>
    console.warn('[claude-history-window] transcript unprovable; boundary inconsistent:', {
      ...context,
      error
    })
  )
  try {
    await readPinnedClaudeTranscript(snapshot, MAX_HISTORY_WINDOW_RECORD_BYTES, pass.add)
  } catch (error) {
    // Unreadable, replaced, or a single record too large to frame: the boundary
    // is unvouched for and absence proves nothing, so sends stay unconfirmed.
    console.warn('[claude-history-window] transcript unreadable; sends stay unconfirmed:', {
      ...context,
      error
    })
    return { ...inconsistent(input), recorded: null }
  }
  return pass.finish()
}
