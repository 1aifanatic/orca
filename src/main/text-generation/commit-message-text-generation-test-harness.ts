import { EventEmitter } from 'node:events'
import { expect, vi } from 'vitest'
import type * as ProviderSupervisor from '../codex/codex-app-server-posix-supervisor'

export type MockDiscoveryChild = EventEmitter & {
  pid: number
  kill: ReturnType<typeof vi.fn>
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: { end: ReturnType<typeof vi.fn> }
}

export function createMockDiscoveryChild(): MockDiscoveryChild {
  const child = new EventEmitter() as MockDiscoveryChild
  child.pid = 123
  child.kill = vi.fn()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { end: vi.fn() }
  return child
}

export function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

// Binds the caller's hoisted tree-kill mock so test bodies keep calling
// expectChildTerminated(child) with no extra argument. Asserts the direct-child kill: a
// supervised child is stopped with SIGTERM instead (source-control-local-process.test.ts).
export function createChildTerminationExpectation(
  terminateWindowsProcessTreeMock: ReturnType<typeof vi.fn>
): (child: { pid: number; kill: ReturnType<typeof vi.fn> }) => Promise<void> {
  return async (child) => {
    if (process.platform === 'win32') {
      expect(terminateWindowsProcessTreeMock).toHaveBeenCalledWith(child.pid, {
        site: 'source-control-text-generation'
      })
    }
    // Every platform kills the root by its own handle. On win32 that is not a
    // duplicate of the tree walk: it is what keeps a refused walk from resolving
    // having killed nothing while the caller releases the managed-home lock. It
    // runs after the walk there, so it can be a tick behind the caller.
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith('SIGKILL'))
  }
}

/**
 * The supervisor module with every agent spawned as a direct child, the unsupervised shape Windows
 * and WSL use, for suites that drive fake children through generation.
 */
export async function directAgentChildSupervisorModule(
  importOriginal: <T>() => Promise<T>
): Promise<typeof ProviderSupervisor> {
  const actual = await importOriginal<typeof ProviderSupervisor>()
  return {
    ...actual,
    createProviderSpawnSpec: (launch, env, _platform, options) =>
      actual.createProviderSpawnSpec(launch, env, 'win32', options)
  }
}
