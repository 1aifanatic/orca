// What restart reconciliation reads from Claude: the anchored window for sends handed over with no
// id, and the id of every user frame the transcript holds for sends handed over under one.
//
// A frame is found by its id wherever it sits, so the id read needs no start point. A frame folded
// into a running turn gets no row of its own, only a `queued_command` attachment naming it by
// `source_uuid`. Frames queued together behind a turn are merged into ONE row under the last
// frame's uuid, so the others cannot be found and stay unconfirmed.

import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  ProviderHistorySource,
  ProviderRecordedHistory
} from '../native-chat/agent-session-journal/journal-submission-reconciler'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { splitTranscriptStreamLines } from '../native-chat/transcript-stream-lines'
import {
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

/** The id a user frame was recorded under, as Claude's own readers take it. */
function recordedFrameUuid(row: Record<string, unknown>): string | null {
  if (row.isSidechain === true) {
    return null
  }
  if (row.type === 'user') {
    return stringField(row, 'uuid')
  }
  const attachment = row.type === 'attachment' ? asRecord(row.attachment) : null
  return attachment?.type === 'queued_command'
    ? (stringField(attachment, 'source_uuid') ?? stringField(row, 'uuid'))
    : null
}

/** Every user frame in the file. A line that does not parse is skipped: it can only hide a send,
 *  which then stays unconfirmed. */
function createRecordedCollector(input: HistoryWindowInput) {
  const itemIds = new Set<string>()
  return {
    add(line: string): void {
      let row: Record<string, unknown> | null = null
      try {
        row = line.trim() ? asRecord(JSON.parse(line)) : null
      } catch {
        return
      }
      const uuid = row && recordedFrameUuid(row)
      if (row && uuid) {
        const sessionId = stringField(row, 'sessionId') ?? input.providerSessionId
        itemIds.add(agentJournalItemKey({ provider: 'claude', sessionId, uuid }))
      }
    },
    finish: (): ProviderRecordedHistory => ({ itemIds })
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
