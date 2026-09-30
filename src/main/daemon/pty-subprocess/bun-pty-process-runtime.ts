import { constants } from 'node:os'
import { createBunPtyTerminalIo } from './bun-pty-terminal-io'
import {
  assignCurrentProcessToBunPtyHostJob,
  type PreparedWindowsBunPtyJob,
  type WindowsBunPtyJob
} from './windows-bun-pty-job'
import type { WindowsBunPtyLaunch } from './windows-bun-pty-launch'
import {
  acquireWindowsBunPtyJob,
  selectWindowsBunPtyLaunch
} from './windows-bun-pty-launch-selection'
import type {
  BunPtyProcess,
  BunPtySpawnArgs,
  BunSubprocess,
  BunTerminal,
  BunTerminalOptions,
  SpawnBunPtyDeps
} from './bun-pty-process-contract'
import { resolveBunRuntime } from './bun-pty-process-capabilities'
import { createBunPtyProducerFlowControl } from './bun-pty-process-flow-control'
import { createPtyOutputPacer } from './bun-pty-output-pacer'

export function spawnBunPty(args: BunPtySpawnArgs, deps: SpawnBunPtyDeps = {}): BunPtyProcess {
  const runtime = resolveBunRuntime(deps.runtime)

  const platform = deps.platform ?? process.platform
  let processHandle: BunSubprocess
  let windowsLaunch: WindowsBunPtyLaunch | null = null
  let windowsJob: WindowsBunPtyJob | null = null
  let preparedJob: PreparedWindowsBunPtyJob | null = null
  let windowsTerminal: BunTerminal | null = null
  let processExitCode: number | undefined
  let terminalFinished = false
  let clearInFlight: Promise<number> | null = null
  const dataListeners = new Set<(data: string) => void>()
  const exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>()
  const decoder = new TextDecoder()
  let pendingData = ''
  let pendingDataError: Error | undefined
  let exited = false
  let exitCode = 0
  let exitSignal: number | undefined

  const emitData = (data: string): void => {
    if (dataListeners.size === 0) {
      if (pendingDataError) {
        return
      }
      if (pendingData.length + data.length > 512 * 1024) {
        pendingDataError = new Error('Terminal output arrived before its consumer was installed')
        pendingData = ''
        return
      }
      pendingData += data
      return
    }
    for (const listener of dataListeners) {
      listener(data)
    }
  }
  const onProcessExit = (code: number): void => {
    processExitCode = code
    windowsLaunch?.dispose()
    if (!windowsTerminal || terminalFinished) {
      emitExit(code)
      return
    }
    // ConPTY closes off-thread; retain listeners until its final frame reaches EOF.
    if (!windowsTerminal.closed) {
      windowsTerminal.close()
    }
  }

  const outputPacer = createPtyOutputPacer(emitData)
  const emitExit = (code: number): void => {
    if (exited) {
      return
    }
    exited = true
    producerFlowControl.resumeForShutdown()
    windowsLaunch?.readShellProcessId()
    exitCode = code
    exitSignal = Object.entries(constants.signals).find(
      ([name]) => name === processHandle.signalCode
    )?.[1]
    // Queued slices precede the decoder tail and must reach listeners before exit.
    outputPacer.flush()
    const pending = decoder.decode()
    if (pending) {
      emitData(pending)
    }
    for (const dispose of [
      () => (processHandle.terminal.closed ? undefined : processHandle.terminal.close()),
      () => windowsJob?.close()
    ]) {
      try {
        dispose()
      } catch (error) {
        console.warn('[daemon/pty] PTY cleanup failed:', error)
      }
    }
    for (const listener of exitListeners) {
      listener({ exitCode: code, ...(exitSignal === undefined ? {} : { signal: exitSignal }) })
    }
    dataListeners.clear()
    exitListeners.clear()
  }

  if (platform === 'win32') {
    if (!(deps.assignHostJob ?? assignCurrentProcessToBunPtyHostJob)()) {
      throw new Error('Windows Bun PTY host crash ownership is unavailable')
    }
    const selected = selectWindowsBunPtyLaunch(args, runtime, deps)
    windowsLaunch = selected.launch
    preparedJob = selected.preparedJob
  }
  try {
    const terminalOptions: BunTerminalOptions = {
      cols: args.cols,
      rows: args.rows,
      name: args.env.TERM ?? 'xterm-256color',
      data: (_terminal, data) => {
        outputPacer.push(decoder.decode(data, { stream: true }))
      },
      exit() {
        terminalFinished = true
        if (processExitCode !== undefined) {
          emitExit(processExitCode)
        }
      }
    }
    // Inline Bun terminals cannot be reused by the Windows clear command.
    if (windowsLaunch) {
      windowsTerminal = new runtime.Terminal(terminalOptions)
    }
    processHandle = runtime.spawn(windowsLaunch?.command ?? [args.file, ...args.args], {
      cwd: args.cwd,
      env: windowsLaunch?.env ?? args.env,
      ...(windowsLaunch
        ? {
            windowsVerbatimArguments: windowsLaunch.windowsVerbatimArguments
          }
        : {}),
      ...(preparedJob ? { windowsJob: preparedJob.handleValue } : {}),
      terminal: windowsTerminal ?? terminalOptions
    })
  } catch (error) {
    windowsTerminal?.close()
    windowsLaunch?.dispose()
    preparedJob?.discard()
    throw error
  }
  if (windowsLaunch) {
    try {
      windowsJob = acquireWindowsBunPtyJob(processHandle.pid, preparedJob, args, deps)
      if (!windowsJob) {
        throw new Error('Windows Bun PTY job ownership is unavailable')
      }
      windowsLaunch.release()
    } catch (error) {
      windowsJob?.terminate()
      try {
        processHandle.kill('SIGTERM')
      } catch {
        // The failed gate release still owns cleanup through the job when available.
      }
      if (!processHandle.terminal.closed) {
        processHandle.terminal.close()
      }
      windowsJob?.close()
      windowsLaunch.dispose()
      // A running gate can temporarily lock its private working directory on Windows.
      const disposeLaunch = (): void => windowsLaunch?.dispose()
      void processHandle.exited.then(disposeLaunch, disposeLaunch)
      throw error
    }
  }
  void processHandle.exited.then(onProcessExit, () => onProcessExit(1))

  const producerFlowControl = createBunPtyProducerFlowControl({
    platform,
    processHandle,
    windowsJob,
    isExited: () => exited,
    ...(deps.readProcessTable ? { readProcessTable: deps.readProcessTable } : {}),
    ...(deps.signalProcessGroup ? { signalProcessGroup: deps.signalProcessGroup } : {})
  })

  const windowsCapabilities = windowsJob
    ? {
        waitForSpawn: () => windowsLaunch?.waitForSpawn(processHandle.exited) ?? Promise.resolve(),
        terminateOwnedTree: () => windowsJob?.terminate() ?? 'unavailable',
        listOwnedProcessIds: () => windowsJob?.listProcessIds() ?? null,
        ...(preparedJob ? {} : { jobRootProcessIsWrapper: true as const }),
        signalProcess(signal: string) {
          if (signal === 'SIGWINCH') {
            return
          }
          if (windowsJob?.terminate() === 'terminated') {
            return
          }
          try {
            processHandle.kill(signal)
          } finally {
            if (!processHandle.terminal.closed) {
              processHandle.terminal.close()
            }
          }
        }
      }
    : {}

  const clearCapability = windowsLaunch
    ? {
        clear() {
          if (exited || clearInFlight) {
            return
          }
          try {
            const clearProcess = runtime.spawn(windowsLaunch.clearCommand, {
              cwd: args.cwd,
              env: args.env,
              terminal: processHandle.terminal,
              windowsVerbatimArguments: true
            })
            clearInFlight = clearProcess.exited
            const settled = (): void => {
              clearInFlight = null
            }
            void clearInFlight.then(settled, settled)
          } catch {
            clearInFlight = null
          }
        }
      }
    : {}

  const terminate = (signal: string): void => {
    producerFlowControl.resumeForShutdown()
    const treeTerminated = windowsJob?.terminate() === 'terminated'
    try {
      processHandle.kill(signal)
    } catch (error) {
      if (!treeTerminated) {
        throw error
      }
    }
  }

  const terminalIo = createBunPtyTerminalIo(
    processHandle.terminal,
    args,
    () => exited,
    () => terminate('SIGKILL')
  )

  return {
    pid: processHandle.pid,
    get shellProcessId() {
      // A direct launch has no wrapper: the job root is the shell.
      return preparedJob ? processHandle.pid : windowsLaunch?.readShellProcessId()
    },
    handleFlowControl: false,
    processNameIsSpawnFile: true,
    clear() {},
    process: args.file,
    get cols() {
      return terminalIo.cols
    },
    get rows() {
      return terminalIo.rows
    },
    write: terminalIo.write,
    resize: terminalIo.resize,
    onData(listener) {
      if (pendingDataError) {
        throw pendingDataError
      }
      if (pendingData) {
        const data = pendingData
        pendingData = ''
        listener(data)
      }
      if (exited) {
        return { dispose() {} }
      }
      dataListeners.add(listener)
      return { dispose: () => dataListeners.delete(listener) }
    },
    onExit(listener) {
      if (exited) {
        listener({ exitCode, ...(exitSignal === undefined ? {} : { signal: exitSignal }) })
        return { dispose() {} }
      }
      exitListeners.add(listener)
      return { dispose: () => exitListeners.delete(listener) }
    },
    ...clearCapability,
    ...producerFlowControl,
    ...windowsCapabilities,
    // Interactive POSIX shells ignore SIGTERM.
    kill(signal = platform === 'win32' ? 'SIGTERM' : 'SIGHUP') {
      if (!exited) {
        terminate(signal)
      }
    },
    destroy() {
      if (!exited) {
        terminate(platform === 'win32' ? 'SIGTERM' : 'SIGHUP')
      }
      if (!processHandle.terminal.closed) {
        processHandle.terminal.close()
      }
    }
  }
}
