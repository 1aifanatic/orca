// Records whether each main-process launch ended through a known exit path, so
// the next launch can tell a native main-process death (which never delivers
// process-gone and writes no breadcrumb) from a user quit.
//
// Two files so the throttled activity write and the exit write never race over
// one path: a stale activity rename cannot clobber an exit record.

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CrashReportBreadcrumbData } from '../../shared/crash-reporting'
import type { MainProcessLifecycleIdentity } from './main-process-lifecycle-identity'

export const MAIN_SESSION_LAUNCH_FILE = 'main-session-launch.json'
export const MAIN_SESSION_EXIT_FILE = 'main-session-exit.json'
const SCHEMA_VERSION = 1
// Bounds when an unmarked session died without a write per breadcrumb.
const ACTIVITY_WRITE_INTERVAL_MS = 60_000

export type MainSessionExitKind =
  | 'quit'
  | 'update-install'
  | 'relaunch'
  | 'os-session-end'
  | 'os-shutdown'

type LaunchRecord = {
  schemaVersion: typeof SCHEMA_VERSION
  launchId: string
  pid: number
  startedAt: string
  appVersion: string
  lastBreadcrumbAt?: string
}

type ExitRecord = {
  schemaVersion: typeof SCHEMA_VERSION
  launchId: string
  kind: MainSessionExitKind
  exitedAt: string
}

export type PreviousUncleanMainSession = Readonly<{
  launchId: string
  pid: number
  startedAt: string
  appVersion: string
  lastBreadcrumbAt: string | null
}>

export type PreviousSessionCrashpadDump = Readonly<{
  writtenAt: string
  sizeBytes: number
  processType: string | null
  dumpCount: number
}>

type TrackingState = {
  launchPath: string
  exitPath: string
  launch: LaunchRecord
}

let tracking: TrackingState | null = null
let exitRecorded = false
let launchWriteChain: Promise<void> = Promise.resolve()
let lastActivityWriteAtMs = Number.NEGATIVE_INFINITY
let activityTimer: NodeJS.Timeout | null = null

function readJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf-8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed))
      : null
  } catch {
    return null
  }
}

function readLaunchRecord(filePath: string): LaunchRecord | null {
  const raw = readJsonObject(filePath)
  if (
    !raw ||
    raw.schemaVersion !== SCHEMA_VERSION ||
    typeof raw.launchId !== 'string' ||
    typeof raw.pid !== 'number' ||
    typeof raw.startedAt !== 'string' ||
    typeof raw.appVersion !== 'string'
  ) {
    return null
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    launchId: raw.launchId,
    pid: raw.pid,
    startedAt: raw.startedAt,
    appVersion: raw.appVersion,
    ...(typeof raw.lastBreadcrumbAt === 'string' ? { lastBreadcrumbAt: raw.lastBreadcrumbAt } : {})
  }
}

function readExitLaunchId(filePath: string): string | null {
  const raw = readJsonObject(filePath)
  return raw?.schemaVersion === SCHEMA_VERSION && typeof raw.launchId === 'string'
    ? raw.launchId
    : null
}

function tempPathFor(filePath: string): string {
  return `${filePath}.${process.pid}.tmp`
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const body = JSON.stringify(value)
  const tempPath = tempPathFor(filePath)
  try {
    await writeFile(tempPath, body)
    await rename(tempPath, filePath)
  } catch {
    // Why: Windows can refuse the replace while a scanner holds the target; a torn
    // direct write is still better evidence than none.
    await writeFile(filePath, body).catch(() => {})
  }
}

function writeJsonAtomicallySync(filePath: string, value: unknown): void {
  const body = JSON.stringify(value)
  const tempPath = tempPathFor(filePath)
  try {
    writeFileSync(tempPath, body)
    renameSync(tempPath, filePath)
  } catch {
    try {
      writeFileSync(filePath, body)
    } catch {
      // Best effort: a missing exit record only costs a false unclean report.
    }
  }
}

function enqueueLaunchWrite(): Promise<void> {
  const state = tracking
  if (!state) {
    return launchWriteChain
  }
  launchWriteChain = launchWriteChain.then(() =>
    writeJsonAtomically(state.launchPath, { ...state.launch })
  )
  return launchWriteChain
}

/**
 * Reads the previous launch's records, then starts tracking this launch.
 * Must run after the single-instance lock so a losing second instance cannot
 * overwrite the running launch's record. Returns the previous launch only when
 * it ended without a recorded exit.
 */
export function beginMainSessionTracking({
  userDataPath,
  identity,
  appVersion
}: {
  userDataPath: string
  identity: MainProcessLifecycleIdentity
  appVersion: string
}): PreviousUncleanMainSession | null {
  const launchPath = path.join(userDataPath, MAIN_SESSION_LAUNCH_FILE)
  const exitPath = path.join(userDataPath, MAIN_SESSION_EXIT_FILE)
  const previous = readLaunchRecord(launchPath)
  const previousExitLaunchId = readExitLaunchId(exitPath)
  tracking = {
    launchPath,
    exitPath,
    launch: {
      schemaVersion: SCHEMA_VERSION,
      launchId: identity.mainProcessLaunchId,
      pid: identity.mainProcessPid,
      startedAt: identity.mainProcessStartedAt,
      appVersion
    }
  }
  exitRecorded = false
  void enqueueLaunchWrite()
  if (
    !previous ||
    previous.launchId === identity.mainProcessLaunchId ||
    previousExitLaunchId === previous.launchId
  ) {
    return null
  }
  return {
    launchId: previous.launchId,
    pid: previous.pid,
    startedAt: previous.startedAt,
    appVersion: previous.appVersion,
    lastBreadcrumbAt: previous.lastBreadcrumbAt ?? null
  }
}

function flushActivity(): void {
  activityTimer = null
  if (!tracking || exitRecorded) {
    return
  }
  lastActivityWriteAtMs = Date.now()
  void enqueueLaunchWrite()
}

/** Throttled: keeps the launch record's last-activity time within one interval of death. */
export function noteMainSessionActivity(createdAt: string): void {
  if (!tracking || exitRecorded) {
    return
  }
  tracking.launch.lastBreadcrumbAt = createdAt
  if (activityTimer) {
    return
  }
  const waitMs = lastActivityWriteAtMs + ACTIVITY_WRITE_INTERVAL_MS - Date.now()
  if (waitMs <= 0) {
    flushActivity()
    return
  }
  activityTimer = setTimeout(flushActivity, waitMs)
  activityTimer.unref()
}

function takeExitRecord(kind: MainSessionExitKind): { path: string; record: ExitRecord } | null {
  // Why first-wins: relaunch/session-end label the exit before the will-quit that may follow.
  if (!tracking || exitRecorded) {
    return null
  }
  exitRecorded = true
  if (activityTimer) {
    clearTimeout(activityTimer)
    activityTimer = null
  }
  return {
    path: tracking.exitPath,
    record: {
      schemaVersion: SCHEMA_VERSION,
      launchId: tracking.launch.launchId,
      kind,
      exitedAt: new Date().toISOString()
    }
  }
}

/** For committed quits that can await teardown (will-quit). */
export function recordMainSessionExit(kind: MainSessionExitKind): Promise<void> {
  const exit = takeExitRecord(kind)
  return exit ? writeJsonAtomically(exit.path, exit.record) : Promise.resolve()
}

/** For exits that may end the process before an async write lands (app.exit, OS teardown). */
export function recordMainSessionExitSync(kind: MainSessionExitKind): void {
  const exit = takeExitRecord(kind)
  if (exit) {
    writeJsonAtomicallySync(exit.path, exit.record)
  }
}

export function buildUncleanMainExitBreadcrumbData(
  previous: PreviousUncleanMainSession,
  dump: PreviousSessionCrashpadDump | null
): CrashReportBreadcrumbData {
  return {
    previousLaunchId: previous.launchId,
    previousPid: previous.pid,
    previousStartedAt: previous.startedAt,
    previousAppVersion: previous.appVersion,
    previousLastBreadcrumbAt: previous.lastBreadcrumbAt,
    crashpadDumpAfterStart: dump !== null,
    ...(dump
      ? {
          dumpWrittenAt: dump.writtenAt,
          dumpSizeBytes: dump.sizeBytes,
          dumpProcessType: dump.processType,
          dumpCount: dump.dumpCount
        }
      : {})
  }
}

export function _resetMainSessionTrackingForTest(): void {
  if (activityTimer) {
    clearTimeout(activityTimer)
  }
  tracking = null
  exitRecorded = false
  launchWriteChain = Promise.resolve()
  lastActivityWriteAtMs = Number.NEGATIVE_INFINITY
  activityTimer = null
}

export function _awaitMainSessionWritesForTest(): Promise<void> {
  return launchWriteChain
}
