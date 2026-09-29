import { lstat } from 'node:fs/promises'
import { connect } from 'node:net'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  codexDaemonSocketPath,
  codexDaemonSocketPathExceedsLimit
} from './codex-daemon-socket-path-guard'

/**
 * `daemon_auto_start = false` stops Codex starting a shared server in Orca's
 * homes, but every launch without `--no-daemon` still joins one that is already
 * running (left from before the update, or started by `codex agents`,
 * `codex remote-control start` or `codex app-server daemon start`). Nothing
 * re-derives that fact, so launch prep checks for it and reports it. It never
 * blocks the launch and never stops the server: that ends every tab attached.
 */
export type CodexSharedServerVerdict = 'live' | 'unverifiable' | 'exited'

const CONNECT_TIMEOUT_MS = 1000

export async function probeCodexSharedServer(
  homePath: string,
  platform: NodeJS.Platform = process.platform
): Promise<CodexSharedServerVerdict> {
  // Why: Codex cannot bind an over-long path, so no server can exist there.
  if (codexDaemonSocketPathExceedsLimit(homePath, platform)) {
    return 'exited'
  }
  const socketPath = codexDaemonSocketPath(homePath, platform)
  if (platform === 'win32') {
    // Why: Node's net on Windows speaks named pipes, not AF_UNIX, so only the socket file is observable.
    try {
      await lstat(socketPath)
      return 'unverifiable'
    } catch (error) {
      return isMissingPathError(error) ? 'exited' : 'unverifiable'
    }
  }
  return connectVerdict(socketPath)
}

function connectVerdict(socketPath: string): Promise<CodexSharedServerVerdict> {
  return new Promise((resolve) => {
    // Why: this is the same bare connect Codex itself uses to decide whether to join.
    const socket = connect({ path: socketPath })
    const settle = (verdict: CodexSharedServerVerdict): void => {
      socket.destroy()
      resolve(verdict)
    }
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => settle('unverifiable'))
    socket.once('connect', () => settle('live'))
    socket.once('error', (error) => {
      const code = errorCode(error)
      settle(
        code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'ENOTDIR'
          ? 'exited'
          : 'unverifiable'
      )
    })
  })
}

const reportedVerdicts = new Map<string, CodexSharedServerVerdict>()

/** Fire-and-forget: logs once per home while a shared server is (or may be) running there. */
export function reportCodexSharedServerInOwnedHome(
  homePath: string,
  platform: NodeJS.Platform = process.platform,
  log: (message: string) => void = (message) => console.warn(message)
): Promise<void> {
  // Why: the host cannot connect to a Linux socket inside WSL; WSL launches rely on the config alone.
  if (parseWslUncPath(homePath)) {
    return Promise.resolve()
  }
  return probeCodexSharedServer(homePath, platform)
    .then((verdict) => {
      // Why: forget an exited server so a later one is reported again.
      if (verdict === 'exited') {
        reportedVerdicts.delete(homePath)
        return
      }
      if (reportedVerdicts.get(homePath) === verdict) {
        return
      }
      reportedVerdicts.set(homePath, verdict)
      const state =
        verdict === 'live'
          ? 'is running'
          : 'may be running (its socket file exists, but Orca cannot connect to it here)'
      log(
        `[codex-shared-server] A shared Codex background server ${state} in Orca's Codex home ${homePath}. Codex sessions started there without --no-daemon (cmd.exe, scripts, absolute paths) join it and run their hooks and tools with the environment of the tab that started it. Orca leaves it running; to stop it, run \`codex app-server daemon stop\` with CODEX_HOME set to that folder.`
      )
    })
    .catch((error: unknown) => {
      console.warn('[codex-shared-server] Could not check for a shared Codex server:', error)
    })
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

function isMissingPathError(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}
