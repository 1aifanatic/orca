import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { spawn as spawnChildProcess, SpawnOptions } from 'node:child_process'
import type { Clipboard } from 'electron'
import type { ElectronApplication, TestInfo } from '@stablyai/playwright-test'
import { shellQuote } from './docker-ssh-relay-target'

type FileClipboardReceipt = { format: string; filePath: string; content: string }
export type NativeFileClipboardRecorder = {
  expectedPath: string
  payloadPath: string
  executablePath: string
}

declare global {
  var __orcaOwnedFileClipboardRecorder:
    | {
        originalWriteBuffer: Clipboard['writeBuffer']
        originalSpawn?: typeof spawnChildProcess
        receipts: FileClipboardReceipt[]
        completedCommands: number
      }
    | undefined
}

export function createNativeFileClipboardRecorder(
  testInfo: TestInfo,
  filePath: string
): NativeFileClipboardRecorder {
  const payloadPath = testInfo.outputPath('native-file-clipboard-payload.txt')
  const executablePath = testInfo.outputPath('native-file-clipboard-recorder.sh')
  mkdirSync(path.dirname(payloadPath), { recursive: true })
  writeFileSync(executablePath, `#!/bin/sh\ncat > ${shellQuote(payloadPath)}\n`)
  chmodSync(executablePath, 0o755)
  return { expectedPath: realpathSync(filePath), payloadPath, executablePath }
}

export async function installNativeFileClipboardRecorder(
  app: ElectronApplication,
  recorder: NativeFileClipboardRecorder
): Promise<void> {
  await app.evaluate(({ clipboard }, target) => {
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      throw new Error('Native file clipboard recording requires macOS or Linux')
    }
    const nodeFs = process.getBuiltinModule('node:fs')
    const nodeUrl = process.getBuiltinModule('node:url')
    const state: NonNullable<typeof global.__orcaOwnedFileClipboardRecorder> = {
      originalWriteBuffer: clipboard.writeBuffer,
      receipts: [],
      completedCommands: 0
    }
    global.__orcaOwnedFileClipboardRecorder = state
    if (process.platform === 'linux') {
      const childProcess = process.getBuiltinModule('node:child_process')
      const originalSpawn: typeof spawnChildProcess = childProcess.spawn
      state.originalSpawn = originalSpawn
      const hasSpawnArgv = (
        value: readonly string[] | SpawnOptions | undefined
      ): value is readonly string[] => Array.isArray(value)
      const recordingSpawn = (
        command: string,
        argsOrOptions?: readonly string[] | SpawnOptions,
        options?: SpawnOptions
      ) => {
        // The real child writes the final clipboard payload into this owned file.
        const clipboardCommand = command === 'wl-copy' || command === 'xclip'
        const program = clipboardCommand ? target.executablePath : command
        const child = hasSpawnArgv(argsOrOptions)
          ? originalSpawn(program, argsOrOptions, options ?? {})
          : originalSpawn(program, [], argsOrOptions ?? {})
        if (clipboardCommand) {
          child.once('exit', (code) => {
            if (code === 0) {
              state.completedCommands += 1
            }
          })
        }
        return child
      }
      childProcess.spawn = new Proxy(originalSpawn, {
        apply(_original, _receiver, args: Parameters<typeof recordingSpawn>) {
          return recordingSpawn(...args)
        }
      })
      process.getBuiltinModule('node:module').syncBuiltinESMExports()
    } else {
      clipboard.writeBuffer = (format, buffer) => {
        const url = buffer
          .toString('utf8')
          .split('\n')
          .find((line) => line.startsWith('file:'))
        if (!url) {
          throw new Error('Expected a native file URL payload')
        }
        const copiedPath = nodeUrl.fileURLToPath(url)
        if (copiedPath !== target.expectedPath) {
          throw new Error('Refusing to read an unowned clipboard target')
        }
        state.receipts.push({
          format,
          filePath: copiedPath,
          content: nodeFs.readFileSync(copiedPath, 'utf8')
        })
      }
    }
  }, recorder)
}

export async function readNativeFileClipboardRecorder(
  app: ElectronApplication,
  recorder: NativeFileClipboardRecorder
): Promise<FileClipboardReceipt[]> {
  if (process.platform !== 'linux') {
    return app.evaluate(() => global.__orcaOwnedFileClipboardRecorder?.receipts ?? [])
  }
  const completed = await app.evaluate(
    () => global.__orcaOwnedFileClipboardRecorder?.completedCommands ?? 0
  )
  if (!completed || !existsSync(recorder.payloadPath)) {
    return []
  }
  const payload = readFileSync(recorder.payloadPath, 'utf8')
  const url = payload
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('file:'))
  if (!url) {
    throw new Error('Expected a recorded file URL payload')
  }
  const filePath = fileURLToPath(url)
  if (filePath !== recorder.expectedPath) {
    throw new Error('Refusing to read an unowned clipboard target')
  }
  return [
    {
      format: payload.startsWith('copy\n') ? 'x-special/gnome-copied-files' : 'text/uri-list',
      filePath,
      content: readFileSync(filePath, 'utf8')
    }
  ]
}

export async function resetNativeFileClipboardRecorder(
  app: ElectronApplication,
  recorder: NativeFileClipboardRecorder
): Promise<void> {
  rmSync(recorder.payloadPath, { force: true })
  await app.evaluate(() => {
    if (global.__orcaOwnedFileClipboardRecorder) {
      global.__orcaOwnedFileClipboardRecorder.receipts.length = 0
      global.__orcaOwnedFileClipboardRecorder.completedCommands = 0
    }
  })
}

export async function restoreNativeFileClipboardRecorder(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ clipboard }) => {
    const state = global.__orcaOwnedFileClipboardRecorder
    if (!state) {
      return
    }
    clipboard.writeBuffer = state.originalWriteBuffer
    if (state.originalSpawn) {
      process.getBuiltinModule('node:child_process').spawn = state.originalSpawn
      process.getBuiltinModule('node:module').syncBuiltinESMExports()
    }
    global.__orcaOwnedFileClipboardRecorder = undefined
  })
}
