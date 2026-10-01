import { readFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { codexDaemonSocketPath } from './codex-daemon-socket-path-guard'
import { readWindowsProcessCreationTime } from '../windows/windows-process-table'

const CONNECT_TIMEOUT_MS = 1_000
// Why cached: every Codex pane on one home asks at once when a worktree opens.
const PROBE_TTL_MS = 3_000
// Codex's FILETIME epoch (1601) sits this far before the Unix epoch.
const FILETIME_UNIX_EPOCH_OFFSET_MS = 11_644_473_600_000n
const probes = new Map<string, { at: number; live: Promise<boolean> }>()

// Why connect, not stat: a server that crashed leaves its socket file behind.
function connectsToSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ path: socketPath })
    const settle = (live: boolean): void => {
      socket.destroy()
      resolve(live)
    }
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => settle(false))
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
  })
}

/**
 * Node cannot open Codex's AF_UNIX socket on Windows (libuv only speaks named
 * pipes), so read the server's pid record instead and require the live process
 * with that pid to have the recorded creation time, which rules out pid reuse.
 */
async function windowsServerRecordIsLive(codexHome: string): Promise<boolean> {
  for (const name of ['daemon.pid', 'app-server.pid']) {
    try {
      const record: unknown = JSON.parse(
        await readFile(join(codexHome, 'app-server-daemon', name), 'utf8')
      )
      if (
        typeof record !== 'object' ||
        record === null ||
        !('pid' in record) ||
        !('processStartTime' in record) ||
        typeof record.pid !== 'number' ||
        typeof record.processStartTime !== 'string' ||
        !/^\d+$/.test(record.processStartTime)
      ) {
        continue
      }
      const startedAtMs = Number(
        BigInt(record.processStartTime) / 10_000n - FILETIME_UNIX_EPOCH_OFFSET_MS
      )
      const createdAtMs = readWindowsProcessCreationTime(record.pid)
      if (createdAtMs !== null && Math.abs(createdAtMs - startedAtMs) < 1_000) {
        return true
      }
    } catch {
      // Missing or unreadable record: no server under this name.
    }
  }
  return false
}

/** Whether Codex's shared server for this CODEX_HOME is accepting clients right now. */
export function isCodexSharedServerLive(codexHome: string): Promise<boolean> {
  const now = Date.now()
  const cached = probes.get(codexHome)
  if (cached && now - cached.at < PROBE_TTL_MS) {
    return cached.live
  }
  const live =
    process.platform === 'win32'
      ? windowsServerRecordIsLive(codexHome)
      : connectsToSocket(codexDaemonSocketPath(codexHome))
  probes.set(codexHome, { at: now, live })
  for (const [home, probe] of probes) {
    if (now - probe.at >= PROBE_TTL_MS) {
      probes.delete(home)
    }
  }
  return live
}

/** Drops a cached answer so the next ask sees a server the caller just stopped. */
export function forgetCodexSharedServerProbe(codexHome: string): void {
  probes.delete(codexHome)
}

export function resetCodexSharedServerProbesForTests(): void {
  probes.clear()
}
