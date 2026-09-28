import type { TerminalProcess } from '../../../shared/terminal-process'
import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import {
  hostReportsChildExitStatus,
  wrapShellSpawnForMacosTccAttribution
} from '../../providers/macos-tcc-login-shell'
import type { WindowsShellSpawnAttempt } from '../../providers/windows-shell-fallback-chain'

import { canUseBunPty, spawnBunPty } from './bun-pty-process'
import { WindowsBunPtySpawnUnconfirmedError } from './windows-bun-pty-spawn-receipt'

export type SpawnedDaemonPty = {
  process: TerminalProcess
  shellPath: string
  spawnCwd: string
  startupCommandDeliveredInShellArgs?: boolean
  /** False when a wrapper owns the reported status, so no exit code may be read from it. */
  reportsChildExitStatus: boolean
}

type NativePtyRuntime = {
  canUseBunPty: typeof canUseBunPty
  spawnBunPty: typeof spawnBunPty
}

/** Walks the Windows PowerShell -> cmd.exe fallback chain when ConPTY rejects the primary shell. */
export async function spawnNativeDaemonPty(
  args: {
    shellPath: string
    shellArgs: string[]
    spawnCwd: string
    env: Record<string, string>
    cols: number
    rows: number
    windowsFallbackAttempts: WindowsShellSpawnAttempt[]
    signal?: AbortSignal
    onMacosTccSpawnStrategy?: (strategy: 'wrapped' | 'direct') => void
  },
  runtime: NativePtyRuntime = { canUseBunPty, spawnBunPty }
): Promise<SpawnedDaemonPty> {
  args.signal?.throwIfAborted()
  if (!runtime.canUseBunPty()) {
    throw new Error('Terminal service requires the bundled Bun runtime')
  }
  let reportsChildExitStatus = true
  const spawnAt = async (
    shellPath: string,
    shellArgs: string[],
    cwd: string
  ): Promise<TerminalProcess> => {
    args.signal?.throwIfAborted()
    const wrapped = wrapShellSpawnForMacosTccAttribution(shellPath, shellArgs, args.env)
    reportsChildExitStatus = hostReportsChildExitStatus(wrapped.file)
    const proc = runtime.spawnBunPty({
      file: wrapped.file,
      args: wrapped.args,
      cwd,
      env: args.env,
      cols: args.cols,
      rows: args.rows
    })
    try {
      if (proc.waitForSpawn) {
        await waitForPromiseWithSignal(proc.waitForSpawn(), args.signal)
      }
      args.signal?.throwIfAborted()
    } catch (error) {
      try {
        proc.destroy()
      } catch (cleanupError) {
        console.warn('[daemon/pty] Failed shell launch cleanup failed:', cleanupError)
      }
      throw error
    }
    args.onMacosTccSpawnStrategy?.(wrapped.file === shellPath ? 'direct' : 'wrapped')
    return proc
  }

  try {
    const process_ = await spawnAt(args.shellPath, args.shellArgs, args.spawnCwd)
    return {
      process: process_,
      shellPath: args.shellPath,
      spawnCwd: args.spawnCwd,
      reportsChildExitStatus
    }
  } catch (primaryErr) {
    args.signal?.throwIfAborted()
    if (process.platform !== 'win32' || primaryErr instanceof WindowsBunPtySpawnUnconfirmedError) {
      throw primaryErr
    }
    for (const attempt of args.windowsFallbackAttempts.slice(1)) {
      try {
        const process = await spawnAt(attempt.shellPath, attempt.shellArgs, attempt.effectiveCwd)
        const message = primaryErr instanceof Error ? primaryErr.message : String(primaryErr)
        console.warn(
          `[daemon/pty] Primary shell "${args.shellPath}" failed (${message}), fell back to "${attempt.shellPath}"`
        )
        return {
          process,
          shellPath: attempt.shellPath,
          spawnCwd: attempt.effectiveCwd,
          startupCommandDeliveredInShellArgs: attempt.startupCommandDeliveredInShellArgs,
          reportsChildExitStatus
        }
      } catch (error) {
        args.signal?.throwIfAborted()
        if (error instanceof WindowsBunPtySpawnUnconfirmedError) {
          throw error
        }
        // This fallback shell also failed -- try the next link in the chain.
      }
    }
    throw primaryErr
  }
}
