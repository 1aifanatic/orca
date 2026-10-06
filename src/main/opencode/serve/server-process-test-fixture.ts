import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { vi } from 'vitest'
import type {
  ManagedProviderProcess,
  ProviderProcessExit
} from '../../provider-process/managed-provider-process'
import type { ProviderProcessCloseResult } from '../../provider-process/provider-process-close'

export function openCodeManagedProcessFixture() {
  const child = Object.assign(new EventEmitter(), {
    pid: 9999999,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true)
  })
  let resolveExit = (): void => {}
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve
  })
  const listeners = new Set<(exit: ProviderProcessExit) => void>()
  let exited = false
  const close = vi.fn<() => Promise<ProviderProcessCloseResult>>(async () => ({
    root: 'unverifiable',
    tree: null
  }))
  const process: ManagedProviderProcess = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture provides exactly the pid, stdio and events the server connection consumes.
    child: child as unknown as ManagedProviderProcess['child'],
    supervised: true,
    processless: false,
    get rootVerdict() {
      return exited ? 'exited' : 'live'
    },
    get rootExitObserved() {
      return exited
    },
    lastCloseResult: null,
    exitPromise,
    stderrTail: () => 'fixture diagnostic',
    onExit(listener) {
      listeners.add(listener)
    },
    terminateTree: async () => 'unverifiable',
    close
  }
  return {
    process,
    child,
    close,
    exit() {
      exited = true
      resolveExit()
      for (const listener of listeners) {
        listener({ code: 1, signal: null, processless: false })
      }
      listeners.clear()
    }
  }
}
