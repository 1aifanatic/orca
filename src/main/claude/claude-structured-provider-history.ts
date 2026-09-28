// What restart reconciliation reads from Claude: the anchored window for sends handed over with no
// id, and every user frame the transcript holds for sends handed over under one.
//
// A frame is found by its id wherever it sits, so the id read needs no start point. What it does
// need is Claude's own recording rules: a frame folded into a running turn gets no row of its own,
// only a `queued_command` attachment naming it by `source_uuid`; and frames queued together behind
// a turn are merged into ONE row under the last frame's uuid, so the others leave only their text.

import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../shared/agent-session-journal-item-key'
import type {
  ProviderHistorySource,
  ProviderRecordedHistory
} from '../native-chat/agent-session-journal/journal-submission-reconciler'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { splitTranscriptStreamLines } from '../native-chat/transcript-stream-lines'
import {
  claudePromptFingerprint,
  MAX_HISTORY_WINDOW_RECORD_BYTES,
  readClaudeProviderHistoryWindow,
  type HistoryWindowInput
} from './claude-structured-history-window'

type HistoryReadInput = HistoryWindowInput & { transcriptPath: string }

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: A non-array object, checked on this line.
      (value as Record<string, unknown>)
    : null
}

function stringField(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key]
  return typeof value === 'string' && value.trim() ? value : null
}

/** The id and content a user frame was recorded under, as Claude's own readers take them. */
function recordedUserFrame(
  row: Record<string, unknown>
): { uuid: string | null; content: unknown } | null {
  if (row.isSidechain === true) {
    return null
  }
  if (row.type === 'user') {
    return { uuid: stringField(row, 'uuid'), content: asRecord(row.message)?.content }
  }
  const attachment = row.type === 'attachment' ? asRecord(row.attachment) : null
  return attachment?.type === 'queued_command'
    ? {
        uuid: stringField(attachment, 'source_uuid') ?? stringField(row, 'uuid'),
        content: attachment.prompt
      }
    : null
}

function textPart(part: unknown): string | null {
  if (typeof part === 'string') {
    return part
  }
  const block = asRecord(part)
  return block?.type === 'text' && typeof block.text === 'string' ? block.text : null
}

/** Each text part on its own: a frame merged into another's row keeps its text there as a block. */
function textParts(content: unknown): string[] {
  const parts =
    typeof content === 'string' ? [content] : Array.isArray(content) ? content.map(textPart) : []
  return parts.filter((text): text is string => typeof text === 'string' && text.trim() !== '')
}

/**
 * Every user frame in the file. Absence counts only when every line of this session's file was
 * read; any line that does not parse may be the missing record.
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
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      whole = false
      return
    }
    const row = asRecord(parsed)
    const frame = row ? recordedUserFrame(row) : null
    if (!row || !frame?.uuid) {
      return
    }
    const sessionId = stringField(row, 'sessionId') ?? input.providerSessionId
    const itemId = agentJournalItemKey({ provider: 'claude', sessionId, uuid: frame.uuid })
    itemIds.add(itemId)
    // Keyed as a one-text-block send is fingerprinted: the only kind reconciled (`comparableBody`).
    for (const text of textParts(frame.content)) {
      const fingerprint = claudePromptFingerprint(input.sessionId, [{ type: 'text', text }])
      const copies = itemIdsByFingerprint.get(fingerprint)
      if (copies) {
        copies.push(itemId)
      } else {
        itemIdsByFingerprint.set(fingerprint, [itemId])
      }
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

/** The string-source twin of `readClaudeRecordedHistory`. */
export function claudeRecordedHistoryFromJsonl(
  input: HistoryWindowInput & { contents: string }
): ProviderRecordedHistory {
  const recorded = createRecordedCollector(input)
  for (const line of input.contents.split('\n')) {
    recorded.add(line)
  }
  return recorded.finish()
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
    console.warn('[claude-history] transcript unreadable; sends stay unconfirmed:', {
      transcriptPath: input.transcriptPath,
      sessionId: input.sessionId,
      error
    })
    return null
  }
  return recorded.finish()
}

/**
 * History for one attached session. Liveness is sampled now, because only the adapter's session
 * map can answer it and a live child means a send queued behind its running turn is not in the
 * file yet. The transcript is resolved and read only when a stranded send needs it.
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
    readWindow: () =>
      readWith(readClaudeProviderHistoryWindow, {
        items: [],
        boundaryConsistent: false,
        turnInFlight: input.hasLiveSession
      }),
    readRecorded: () => readWith(readClaudeRecordedHistory, null)
  }
}
