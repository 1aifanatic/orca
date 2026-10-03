import { join } from 'node:path'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { getAiVaultWslHomeDirs } from '../ai-vault/cached-session-list'
import { prepareOpenCodeWslReaders } from '../ai-vault/opencode-wsl-runtime-preparation'
import { configureOpenCodeWslReaders } from '../ai-vault/session-scanner-opencode-wsl-client'
import { readOpenCodeTranscriptSignalViaWorker } from '../ai-vault/session-scanner-opencode-sqlite-worker-spawn'
import {
  compareOpenCodeClaimPriority,
  listOpenCodeDatabases,
  listOpenCodeDatabasesInDirectory
} from '../opencode-usage/opencode-database-discovery'

export async function discoverOpenCodeTranscriptDatabase(
  sessionId?: string,
  signal?: AbortSignal
): Promise<string | null> {
  signal?.throwIfAborted()
  const deadline = new AbortController()
  const timer = setTimeout(
    () =>
      deadline.abort(new Error('OpenCode transcript database discovery exceeded its time limit')),
    5000
  )
  timer.unref?.()
  const boundedSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal
  const refusals: Error[] = []
  const onRefusal = (_path: string, error: Error): void => {
    refusals.push(error)
  }
  try {
    const homes = await waitForPromiseWithSignal(getAiVaultWslHomeDirs(), boundedSignal)
    const sources = await waitForPromiseWithSignal(
      Promise.all([
        listOpenCodeDatabases(onRefusal, boundedSignal),
        ...homes
          .slice(0, 32)
          .map((home) =>
            listOpenCodeDatabasesInDirectory(
              join(home, '.local', 'share', 'opencode'),
              onRefusal,
              boundedSignal
            )
          )
      ]),
      boundedSignal
    )
    if (homes.length > 0) {
      const readers = await waitForPromiseWithSignal(
        prepareOpenCodeWslReaders(homes),
        boundedSignal
      )
      boundedSignal.throwIfAborted()
      configureOpenCodeWslReaders(readers)
    }
    const paths = [...new Set(sources.flat())].sort(compareOpenCodeClaimPriority)
    for (const dbPath of paths.slice(0, 32)) {
      boundedSignal.throwIfAborted()
      if (
        !sessionId ||
        (await waitForPromiseWithSignal(
          readOpenCodeTranscriptSignalViaWorker({ dbPath, sessionId }, boundedSignal),
          boundedSignal
        ))
      ) {
        return dbPath
      }
    }
    if (refusals[0]) {
      throw refusals[0]
    }
    return null
  } finally {
    clearTimeout(timer)
  }
}
