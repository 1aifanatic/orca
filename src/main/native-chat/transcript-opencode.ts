import {
  OPENCODE_CAPTURE_RECORD_LIMIT,
  OPENCODE_CAPTURE_TEXT_LIMIT
} from '../ai-vault/opencode-transcript-capture-limits'
import { basename } from 'node:path'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { errorMessage } from '../ai-vault/session-scanner-values'
import type { ReadTranscriptResult } from './transcript-reader'
import {
  readOpenCodeTranscriptPageViaWorker,
  readOpenCodeTranscriptSignalViaWorker
} from '../ai-vault/session-scanner-opencode-sqlite-worker-spawn'
import { listOpenCodeDatabases } from '../opencode-usage/opencode-database-discovery'
import type {
  OpenCodeTranscriptPage,
  OpenCodeTranscriptSignal
} from './transcript-opencode-sqlite-query'
import { DESKTOP_READ_WINDOW } from './transcript-watch-contract'

// OpenCode SQLite reads use the same bounded worker as AI Vault.

export type OpenCodeTranscriptDeps = {
  resolveDbPath?: (sessionId?: string, signal?: AbortSignal) => Promise<string | null>
  readSignal?: (
    dbPath: string,
    sessionId: string,
    signal?: AbortSignal
  ) => Promise<OpenCodeTranscriptSignal | null>
  readPage?: (
    args: {
      dbPath: string
      sessionId: string
      limit: number
      beforeMessageRowId?: number
    },
    signal?: AbortSignal
  ) => Promise<OpenCodeTranscriptPage | null>
}

async function defaultResolveDbPath(
  sessionId?: string,
  signal?: AbortSignal
): Promise<string | null> {
  const paths = (await listOpenCodeDatabases()).sort(
    (a, b) => Number(basename(b) === 'opencode.db') - Number(basename(a) === 'opencode.db')
  )
  const deadline = Date.now() + 5000
  for (const dbPath of paths.slice(0, 32)) {
    signal?.throwIfAborted()
    if (Date.now() > deadline) {
      throw new Error('OpenCode transcript database discovery exceeded its time limit')
    }
    if (
      !sessionId ||
      (await readOpenCodeTranscriptSignalViaWorker({ dbPath, sessionId }, signal))
    ) {
      return dbPath
    }
  }
  return null
}

export function resolveOpenCodeTranscriptDbPath(sessionId?: string): Promise<string | null> {
  return defaultResolveDbPath(sessionId)
}

export const openCodeTranscriptDefaultDeps: Required<OpenCodeTranscriptDeps> = {
  resolveDbPath: defaultResolveDbPath,
  readSignal: (dbPath, sessionId, signal) =>
    readOpenCodeTranscriptSignalViaWorker({ dbPath, sessionId }, signal),
  readPage: (args, signal) => readOpenCodeTranscriptPageViaWorker(args, signal)
}

export type OpenCodeTailResult =
  | { messages: NativeChatMessage[]; hasMore: boolean; beforeOffset: number }
  | { error: string; notFound?: true }

export async function readOpenCodeNativeChatTranscriptTail(
  args: { sessionId: string; limit: number; beforeOffset?: number },
  deps: OpenCodeTranscriptDeps = {},
  signal?: AbortSignal
): Promise<OpenCodeTailResult> {
  const limit = args.limit > 0 ? Math.floor(args.limit) : DESKTOP_READ_WINDOW
  try {
    const dbPath = await (deps.resolveDbPath ?? openCodeTranscriptDefaultDeps.resolveDbPath)(
      args.sessionId,
      signal
    )
    if (!dbPath) {
      return { error: 'Transcript unavailable', notFound: true }
    }
    const page = await (deps.readPage ?? openCodeTranscriptDefaultDeps.readPage)(
      {
        dbPath,
        sessionId: args.sessionId,
        limit,
        ...(args.beforeOffset !== undefined ? { beforeMessageRowId: args.beforeOffset } : {})
      },
      signal
    )
    if (!page) {
      return { error: 'Transcript unavailable', notFound: true }
    }
    return {
      messages: page.items.map((item) => item.message),
      hasMore: page.hasMore,
      beforeOffset: page.beforeMessageRowId ?? 0
    }
  } catch (err) {
    return { error: errorMessage(err) }
  }
}

export async function readOpenCodeNativeChatTranscriptFull(
  sessionId: string,
  deps: OpenCodeTranscriptDeps = {},
  signal?: AbortSignal
): Promise<ReadTranscriptResult> {
  // Pages arrive newest-window first; reverse windows, preserving message order.
  const pages: NativeChatMessage[][] = []
  let records = 0
  let bytes = 0
  let cursor: number | undefined
  try {
    const dbPath = await (deps.resolveDbPath ?? openCodeTranscriptDefaultDeps.resolveDbPath)(
      sessionId,
      signal
    )
    if (!dbPath) {
      return { error: 'Transcript unavailable', notFound: true }
    }
    const readPage = deps.readPage ?? openCodeTranscriptDefaultDeps.readPage
    for (;;) {
      const page = await readPage(
        {
          dbPath,
          sessionId,
          limit: 500,
          ...(cursor !== undefined ? { beforeMessageRowId: cursor } : {})
        },
        signal
      )
      if (!page) {
        if (cursor === undefined) {
          return { error: 'Transcript unavailable', notFound: true }
        }
        break
      }
      pages.push(page.items.map((item) => item.message))
      records += page.items.length
      bytes += Buffer.byteLength(JSON.stringify(page.items))
      if (records > OPENCODE_CAPTURE_RECORD_LIMIT || bytes > OPENCODE_CAPTURE_TEXT_LIMIT) {
        throw new Error('OpenCode transcript exceeds its full read limit')
      }
      if (!page.hasMore || page.beforeMessageRowId == null || page.beforeMessageRowId === cursor) {
        break
      }
      cursor = page.beforeMessageRowId
    }
  } catch (err) {
    return { error: errorMessage(err) }
  }
  return { messages: pages.toReversed().flat() }
}
