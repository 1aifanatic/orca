import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { buildWslCodexAppServerArgs } from '../codex-accounts/wsl-codex-command'
import { resolveCodexCommand } from '../codex-cli/command'
import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import { CODEX_READ_ONLY_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'
import { terminateCodexProbeChild } from '../rate-limits/codex-probe-termination'
import type { ChildProcessHandle } from '../../shared/child-process/process-spec'
import {
  spawnCodexAppServerProcess,
  type CodexAppServerSpawn
} from './codex-app-server-process-tree-kill'
import {
  BACKFILL_PENDING_MIN_SESSION_FILES,
  countCodexSessionFilesUpTo,
  isCodexStateDbBackfillPending,
  readCodexStateDbBackfillSnapshot,
  type CodexStateDbBackfillStatus
} from './codex-state-db'
import { withCodexBackfillSupervisorLock } from './codex-state-db-backfill-supervisor-lock'

const RECOVERY_POLL_INTERVAL_MS = 5_000
const RECOVERY_RETRY_DELAY_MS = 2_000
const RECOVERY_MAX_COORDINATOR_FAILURES = 5
const RECOVERY_MAX_SPAWNS = 5
const RECOVERY_MAX_TOTAL_MS = 60 * 60_000

export type CodexStateDbBackfillRecoverySummary = {
  outcome: 'completed' | 'already-complete' | 'not-needed' | 'unreadable' | 'stopped' | 'gave-up'
  spawnCount: number
}

type RecoveryDependencies = {
  spawnProcess: CodexAppServerSpawn
  resolveCommand: () => string
  /** Null when the index reader did not answer (timeout, crash, no worker). */
  readStatus: (codexHomePath: string) => Promise<CodexStateDbBackfillStatus | null>
  countSessions: (sessionsRoot: string, limit: number) => Promise<number>
  now: () => number
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  terminate: (child: ChildProcessHandle) => Promise<void>
}

const defaultDependencies: RecoveryDependencies = {
  spawnProcess: spawnCodexAppServerProcess,
  resolveCommand: resolveCodexCommand,
  readStatus: async (codexHomePath) =>
    (await readCodexStateDbBackfillSnapshot(codexHomePath, 0))?.status ?? null,
  countSessions: countCodexSessionFilesUpTo,
  now: Date.now,
  sleep: async (ms, signal) => await delay(ms, undefined, { signal }),
  terminate: async (child) => await terminateCodexProbeChild(child)
}

function finish(
  outcome: CodexStateDbBackfillRecoverySummary['outcome'],
  spawnCount: number
): CodexStateDbBackfillRecoverySummary {
  return { outcome, spawnCount }
}

async function initialRecoveryDecision(
  codexHomePath: string,
  dependencies: RecoveryDependencies
): Promise<CodexStateDbBackfillRecoverySummary['outcome'] | null> {
  const status = await dependencies.readStatus(codexHomePath)
  if (status?.kind === 'complete') {
    return 'already-complete'
  }
  // Why: never spawn a claimant against an index whose state nobody could read.
  if (!status || status.kind === 'unreadable') {
    return 'unreadable'
  }
  if (
    (status.kind === 'missing' || status.kind === 'not-tracked') &&
    (await dependencies.countSessions(
      join(codexHomePath, 'sessions'),
      BACKFILL_PENDING_MIN_SESSION_FILES
    )) < BACKFILL_PENDING_MIN_SESSION_FILES
  ) {
    return 'not-needed'
  }
  return null
}

function spawnRecoveryProcess(
  codexHomePath: string,
  dependencies: RecoveryDependencies
): ChildProcessHandle {
  const wslHome = process.platform === 'win32' ? parseWslUncPath(codexHomePath) : null
  if (wslHome) {
    return dependencies.spawnProcess(
      'wsl.exe',
      buildWslCodexAppServerArgs(
        wslHome.distro,
        wslHome.linuxPath,
        CODEX_READ_ONLY_APP_SERVER_ARGS
      ),
      {
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
        env: process.env
      }
    )
  }
  const command = dependencies.resolveCommand()
  return dependencies.spawnProcess(command, [...CODEX_READ_ONLY_APP_SERVER_ARGS], {
    cwd: codexHomePath,
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
    env: withCliRuntimeOnPath(command, { ...process.env, CODEX_HOME: codexHomePath })
  })
}

/** Keeps a sanctioned app-server claimant alive until Codex completes its own backfill. */
export async function runCodexStateDbBackfillRecovery(
  codexHomePath: string,
  signal: AbortSignal,
  dependenciesOverride: Partial<RecoveryDependencies> = {}
): Promise<CodexStateDbBackfillRecoverySummary> {
  const dependencies = { ...defaultDependencies, ...dependenciesOverride }
  const initialOutcome = await initialRecoveryDecision(codexHomePath, dependencies)
  if (initialOutcome) {
    return finish(initialOutcome, 0)
  }

  const deadline = dependencies.now() + RECOVERY_MAX_TOTAL_MS
  let spawnCount = 0
  while (!signal.aborted && dependencies.now() < deadline && spawnCount < RECOVERY_MAX_SPAWNS) {
    const child = spawnRecoveryProcess(codexHomePath, dependencies)
    spawnCount += 1
    let childDown = false
    child.once('error', () => {
      childDown = true
    })
    child.once('exit', () => {
      childDown = true
    })

    try {
      while (!childDown && !signal.aborted && dependencies.now() < deadline) {
        await dependencies.sleep(RECOVERY_POLL_INTERVAL_MS, signal)
        const status = await dependencies.readStatus(codexHomePath)
        // A reader that did not answer says nothing about the index: keep polling.
        if (status?.kind === 'complete') {
          await dependencies.terminate(child)
          return finish('completed', spawnCount)
        }
        if (status?.kind === 'unreadable') {
          await dependencies.terminate(child)
          return finish('unreadable', spawnCount)
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        await dependencies.terminate(child)
        throw error
      }
    }

    if (signal.aborted) {
      await dependencies.terminate(child)
      return finish('stopped', spawnCount)
    }
    if (!childDown) {
      await dependencies.terminate(child)
      return finish('gave-up', spawnCount)
    }
    if (spawnCount >= RECOVERY_MAX_SPAWNS) {
      return finish('gave-up', spawnCount)
    }
    try {
      await dependencies.sleep(RECOVERY_RETRY_DELAY_MS, signal)
    } catch {
      return finish('stopped', spawnCount)
    }
  }
  return finish(signal.aborted ? 'stopped' : 'gave-up', spawnCount)
}

type ActiveRecovery = {
  controller: AbortController
  ready: Promise<void>
  task: Promise<CodexStateDbBackfillRecoverySummary | null>
}

const activeRecoveries = new Map<string, ActiveRecovery>()
const coordinatorFailureCounts = new Map<string, number>()
let stopping = false

type RecoveryCoordinatorDependencies = {
  isPending: typeof isCodexStateDbBackfillPending
  run: typeof runCodexStateDbBackfillRecovery
  withLock: typeof withCodexBackfillSupervisorLock
}

const defaultCoordinatorDependencies: RecoveryCoordinatorDependencies = {
  isPending: isCodexStateDbBackfillPending,
  run: runCodexStateDbBackfillRecovery,
  withLock: withCodexBackfillSupervisorLock
}

/** `not-pending`: no recovery was needed, so the slot is released like a finished one. */
type RecoveryAttempt = CodexStateDbBackfillRecoverySummary | null | 'not-pending'

function settleRecoveryEntry(
  key: string,
  task: ActiveRecovery['task'],
  summary: RecoveryAttempt
): void {
  if (activeRecoveries.get(key)?.task !== task) {
    return
  }
  if (summary !== 'not-pending' && summary?.outcome === 'gave-up') {
    coordinatorFailureCounts.delete(key)
    return
  }
  if (summary === null) {
    const failureCount = (coordinatorFailureCounts.get(key) ?? 0) + 1
    if (failureCount >= RECOVERY_MAX_COORDINATOR_FAILURES) {
      coordinatorFailureCounts.delete(key)
      return
    }
    coordinatorFailureCounts.set(key, failureCount)
  } else {
    coordinatorFailureCounts.delete(key)
  }
  activeRecoveries.delete(key)
}

export function startCodexStateDbBackfillRecoveryInBackground(
  codexHomePath: string,
  dependenciesOverride: Partial<RecoveryCoordinatorDependencies> = {}
): Promise<CodexStateDbBackfillRecoverySummary | null> {
  const dependencies = { ...defaultCoordinatorDependencies, ...dependenciesOverride }
  const key = normalizeRuntimePathForComparison(codexHomePath)
  const existing = activeRecoveries.get(key)
  if (existing) {
    return existing.task
  }
  if (stopping) {
    return Promise.resolve(null)
  }
  const controller = new AbortController()
  let markReady!: () => void
  const ready = new Promise<void>((resolve) => (markReady = resolve))
  const attempt = attemptRecovery(codexHomePath, controller, markReady, dependencies)
  const task = attempt.then((result) => (result === 'not-pending' ? null : result))
  void task.finally(markReady)
  // Why before any await: the pending read is async, so the slot is reserved first;
  // a concurrent start then shares this task and `ensure` waits on this `ready`.
  activeRecoveries.set(key, { controller, ready, task })
  void attempt.then((result) => {
    settleRecoveryEntry(key, task, result)
  })
  return task
}

async function attemptRecovery(
  codexHomePath: string,
  controller: AbortController,
  markReady: () => void,
  dependencies: RecoveryCoordinatorDependencies
): Promise<RecoveryAttempt> {
  try {
    if (!(await dependencies.isPending(codexHomePath)) || controller.signal.aborted) {
      return 'not-pending'
    }
    return await dependencies.withLock(codexHomePath, controller.signal, async () => {
      console.info(`[codex-state-db-backfill] supervising Codex index at ${codexHomePath}`)
      markReady()
      return await dependencies.run(codexHomePath, controller.signal)
    })
  } catch (error: unknown) {
    if (!controller.signal.aborted) {
      console.warn('[codex-state-db-backfill] recovery supervisor stopped:', error)
    }
    return null
  }
}

/** Waits only for exact-owner arbitration, never for the potentially long Codex index. */
export async function ensureCodexStateDbBackfillRecoveryStarted(
  codexHomePath: string
): Promise<void> {
  void startCodexStateDbBackfillRecoveryInBackground(codexHomePath)
  await activeRecoveries.get(normalizeRuntimePathForComparison(codexHomePath))?.ready
}

export async function stopCodexStateDbBackfillRecoveries(): Promise<void> {
  stopping = true
  const recoveries = [...activeRecoveries.values()]
  for (const recovery of recoveries) {
    recovery.controller.abort()
  }
  await Promise.allSettled(recoveries.map(({ task }) => task))
}

export const _internals = {
  resetForTests(): void {
    stopping = false
    activeRecoveries.clear()
    coordinatorFailureCounts.clear()
  }
}
