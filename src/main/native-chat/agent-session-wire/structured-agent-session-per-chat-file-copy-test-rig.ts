// Chats an earlier build left in per-chat files, on a real host, and the background copy job driven
// a run at a time on a clock the test moves.

import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import {
  moveChatToPerChatFile,
  writePerChatJournalFile
} from '../agent-session-journal/journal-per-chat-file-test-support'
import {
  legacyJournalDatabaseFile,
  perChatJournalRoot
} from '../agent-session-journal/journal-paths'
import { StructuredAgentSessionPerChatFileCopyPace } from './structured-agent-session-per-chat-file-copy-pace'
import {
  StructuredAgentSessionPerChatFileCopy,
  type PerChatFileCopyDeps
} from './structured-agent-session-per-chat-file-copy'
import {
  createRestTestRig,
  restTestChat,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'
import { createStructuredAgentSessionStartupState } from './structured-agent-session-startup-state'

export const COPY_TEST_WORKSPACE = 'workspace-1'

export type CopyTestRig = RestTestRig & { copyClock: { now: number } }

export async function createCopyTestRig(): Promise<CopyTestRig> {
  return Object.assign(await createRestTestRig(), { copyClock: { now: 0 } })
}

/** Creates each chat (listed unless told not to), sending one message so it has history. */
export async function createChats(
  rig: RestTestRig,
  ids: readonly string[],
  options: { listed?: boolean; message?: boolean } = {}
): Promise<void> {
  for (const sessionId of ids) {
    await restTestChat(rig, sessionId, {
      listed: options.listed !== false,
      ...(options.message === false ? {} : { message: `asked ${sessionId}` })
    })
  }
}

/** After a crash: moves each chat out of the host's database into its per-chat file. */
export function moveToPerChatFiles(rig: RestTestRig, ids: readonly string[]): void {
  const database = openTestJournalHostDatabase(rig.root)
  for (const sessionId of ids) {
    moveChatToPerChatFile(database, { sessionId, workspaceId: COPY_TEST_WORKSPACE })
  }
}

/** A per-chat file whose contents only a fake importer reads. */
export function writeStubPerChatFile(rig: RestTestRig, sessionId: string): string {
  const directory = openTestJournalHostDatabase(rig.root).legacyDirectoryFor({
    sessionId,
    workspaceId: COPY_TEST_WORKSPACE
  })
  return writePerChatJournalFile(directory, sessionId, { epoch: 'stub', rows: [] })
}

export function hasPerChatFile(rig: RestTestRig, sessionId: string): boolean {
  const directory = openTestJournalHostDatabase(rig.root).legacyDirectoryFor({
    sessionId,
    workspaceId: COPY_TEST_WORKSPACE
  })
  return existsSync(legacyJournalDatabaseFile(directory))
}

/** Every `journal.db` left under the old-file root. */
export async function perChatFilesLeft(rig: RestTestRig): Promise<number> {
  const root = perChatJournalRoot(rig.root)
  if (!existsSync(root)) {
    return 0
  }
  let files = 0
  for (const workspace of await readdir(root)) {
    for (const session of await readdir(join(root, workspace))) {
      files += existsSync(legacyJournalDatabaseFile(join(root, workspace, session))) ? 1 : 0
    }
  }
  return files
}

/** The job over the rig's current host, never started on a timer: a test calls `tick`. */
export function copyJob(
  rig: CopyTestRig,
  overrides: Partial<PerChatFileCopyDeps> = {}
): StructuredAgentSessionPerChatFileCopy {
  return new StructuredAgentSessionPerChatFileCopy({ ...copyJobDeps(rig), ...overrides })
}

/** The job's dependencies over the rig's current host. Its settle is the startup state's own,
 *  counted, and its rule for which chats this host settles is the rig adapter's. */
export function copyJobDeps(rig: CopyTestRig): PerChatFileCopyDeps {
  const { sessions, tasks } = rig.host.collaboratorsForTests()
  const { serialize } = tasks
  const database = openTestJournalHostDatabase(rig.root)
  // The rig adapter's own rule.
  const canSettle = (record: AgentSessionRecord | null): record is AgentSessionRecord =>
    record !== null && !rig.unsupportedWorkspaceIds.has(record.location.workspaceId)
  const startup = createStructuredAgentSessionStartupState({
    openDeps: {
      store: rig.store,
      adapter: {
        historyFilePath: ({ identity }) => rig.adapter.historyFilePath(identity.sessionId)
      },
      journalDatabase: database,
      logger: rig.host.deps.logger
    },
    canSettle,
    seedStatus: () => undefined,
    resolveRecovery: async () => true,
    restoreListed: async () => undefined,
    serialize,
    hasSession: (sessionId) => sessions.has(sessionId),
    isDisposed: () => false
  })
  return {
    database,
    store: rig.store,
    listedIds: rig.store.getVisibleSessionTabIndex().sessionIds,
    isStartupChatWorkActive: () => false,
    tasks,
    openJournal: (sessionId) => sessions.get(sessionId)?.journal,
    settleClosedChat: vi.fn(startup.settleClosedChat),
    canSettle,
    isDisposed: () => false,
    logger: rig.host.deps.logger,
    now: () => rig.copyClock.now,
    appVersion: '1.0.0',
    freeBytes: async () => null,
    startDelayMs: 0,
    // On the job's clock: work the test charges by moving it is paced, and a wait moves it.
    pace: new StructuredAgentSessionPerChatFileCopyPace(
      () => rig.copyClock.now,
      async (ms) => {
        rig.copyClock.now += ms
      }
    )
  }
}

/** Ticks until the job has finished, a second of its clock apart; answers how many ticks it took. */
export async function runToEnd(
  rig: CopyTestRig,
  job: StructuredAgentSessionPerChatFileCopy,
  limit = 100
): Promise<number> {
  for (let ticks = 1; ticks <= limit; ticks += 1) {
    rig.copyClock.now += 1_000
    await job.tick()
    if (job.isFinished) {
      return ticks
    }
  }
  throw new Error(`the copy did not finish within ${limit} ticks`)
}
