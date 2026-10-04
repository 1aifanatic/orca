import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { DaemonClient } from '../../../src/main/daemon/client'
import { parseDaemonPidFile } from '../../../src/main/daemon/daemon-pid-file-parse'
import {
  commandLineMatchesDaemon,
  inspectDaemonProcessIdentity
} from '../../../src/main/daemon/daemon-pid-identity'
import {
  getDaemonPidPath,
  getDaemonSocketPath,
  getDaemonTokenPath
} from '../../../src/main/daemon/daemon-spawner'
import type { ListSessionsResult } from '../../../src/main/daemon/types'
import {
  isWindowsProcessTableAvailable,
  isWindowsProcessStartTimeAvailable,
  readWindowsProcessCreationTime,
  readWindowsProcessTableFresh
} from '../../../src/main/windows/windows-process-table'
import { expect } from './orca-app'

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH') {
      return false
    }
    throw error
  }
}

export async function recordRatioDaemon(userDataDir: string, ptyIds: string[]) {
  const runtimeDir = path.join(userDataDir, 'daemon')
  const socketPath = getDaemonSocketPath(runtimeDir)
  const tokenPath = getDaemonTokenPath(runtimeDir)
  const record = parseDaemonPidFile(readFileSync(getDaemonPidPath(runtimeDir), 'utf8'))
  if (
    !record?.entryPath ||
    !record.launchNonce ||
    !record.startedAtMs ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0
  ) {
    throw new Error('Ratio fixture requires a full owned daemon PID record')
  }
  const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
  expect(digest(record.entryPath)).toBe(
    digest(path.join(process.cwd(), 'out', 'main', 'daemon-entry.js'))
  )
  const client = new DaemonClient({ socketPath, tokenPath })
  try {
    await client.ensureConnectedWithin(5_000)
    expect(client.getDaemonIdentity()).toMatchObject({
      pid: record.pid,
      launchNonce: record.launchNonce
    })
    const listed = await client.request<ListSessionsResult>('listSessions', undefined, 5_000)
    const requestedPtyIds = ptyIds.length
      ? ptyIds
      : listed.sessions.filter((session) => session.isAlive).map((session) => session.sessionId)
    const sessions = requestedPtyIds.map((ptyId) => {
      const session = listed.sessions.find((session) => session.sessionId === ptyId)
      if (!session?.isAlive || !session.pid || !session.incarnationId) {
        throw new Error(`Ratio PTY ${ptyId} lacks a live native shell`)
      }
      return session
    })
    return { record, socketPath, tokenPath, sessions, entrySha256: digest(record.entryPath) }
  } finally {
    client.disconnect()
  }
}

export async function stopRatioDaemon(owned: Awaited<ReturnType<typeof recordRatioDaemon>>) {
  const { record, socketPath, tokenPath } = owned
  if (process.platform === 'win32') {
    expect(isWindowsProcessTableAvailable()).toBe(true)
    expect(isWindowsProcessStartTimeAvailable()).toBe(true)
    const row = (await readWindowsProcessTableFresh()).find((row) => row.pid === record.pid)
    const startedAtMs = row?.creationTimeMs ?? readWindowsProcessCreationTime(record.pid)
    expect(row?.command && commandLineMatchesDaemon(row.command, socketPath, tokenPath)).toBe(true)
    expect(record.entryPath && row?.command.includes(record.entryPath)).toBe(true)
    expect(startedAtMs).not.toBeNull()
    expect(Math.abs((startedAtMs ?? 0) - (record.startedAtMs ?? 0))).toBeLessThan(10_000)
  } else {
    expect(
      await inspectDaemonProcessIdentity(record.pid, socketPath, tokenPath, record.startedAtMs)
    ).toBe('match')
  }
  process.kill(record.pid, 'SIGKILL')
  const pids = [
    record.pid,
    ...owned.sessions.flatMap((session) => (session.pid ? [session.pid] : []))
  ]
  await expect
    .poll(() => pids.filter(processExists), {
      timeout: 15_000,
      message: 'Owned daemon and its native shells must exit before the cold launch'
    })
    .toEqual([])
  return { killedPid: record.pid, exitedPids: pids, at: new Date().toISOString() }
}

export async function cleanupRatioDaemon(userDataDir: string) {
  const runtimeDir = path.join(userDataDir, 'daemon')
  const pidPath = getDaemonPidPath(runtimeDir)
  let stopped: Awaited<ReturnType<typeof stopRatioDaemon>> | undefined
  if (existsSync(pidPath)) {
    const raw = readFileSync(pidPath, 'utf8')
    const record = parseDaemonPidFile(raw)
    if (!record || !Number.isSafeInteger(record.pid) || record.pid <= 0) {
      throw new Error('Cannot clean up an unverifiable fixture daemon record')
    }
    if (processExists(record.pid)) {
      stopped = await stopRatioDaemon(await recordRatioDaemon(userDataDir, []))
    }
    if (existsSync(pidPath)) {
      expect(readFileSync(pidPath, 'utf8')).toBe(raw)
      unlinkSync(pidPath)
    }
  }
  const remaining = existsSync(runtimeDir)
    ? readdirSync(runtimeDir).filter((name) => name.endsWith('.pid'))
    : []
  expect(remaining).toEqual([])
  return { stopped, remainingDaemonPidFiles: remaining }
}
