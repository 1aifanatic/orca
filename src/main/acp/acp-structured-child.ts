// The ACP agent's process, as the adapter needs it: its stdio for the protocol, its observed exit,
// and a close that answers true only once that exit is proven. Supervision, the process-tree
// teardown and Windows-safe spawning are the shared provider lifecycle's.

import type { Readable, Writable } from 'node:stream'
import { spawnProcess } from '../../shared/child-process/run-process'
import { spawnManagedProviderProcess } from '../provider-process/managed-provider-process'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'

export type AcpStructuredChild = {
  readonly pid: number | undefined
  /** Agent → Orca. */
  readonly stdout: Readable
  /** Orca → agent. */
  readonly stdin: Writable
  readonly exited: boolean
  /** Resolves once the spawn either produced a process or failed to. */
  readonly spawned: Promise<void>
  onExit(listener: () => void): void
  /** The agent's own last words, for a failure a person reads. */
  stderrTail(): string
  /** True only once the exit is proven. */
  close(): Promise<boolean>
  /** The root exited but the close could not prove its process tree gone. */
  readonly treeUnproven: boolean
}

export type SpawnAcpStructuredChild = (launch: ProviderProcessLaunch) => AcpStructuredChild

export function spawnAcpStructuredChild(
  launch: ProviderProcessLaunch,
  spawnImpl: typeof spawnProcess = spawnProcess
): AcpStructuredChild {
  // The managed process owns the close ladder, its root-only defaults, and the stderr tail.
  const managed = spawnManagedProviderProcess(launch, { spawnImpl, site: 'acp-agent-teardown' })
  const { child } = managed
  // A broken pipe surfaces as the exit the managed process observes; never as an uncaught error.
  child.stdin.on('error', () => {})
  const spawned = new Promise<void>((resolve) => {
    if (child.pid !== undefined) {
      resolve()
      return
    }
    child.once('spawn', () => resolve())
    child.once('error', () => resolve())
  })
  return {
    get pid() {
      return child.pid
    },
    stdout: child.stdout,
    stdin: child.stdin,
    get exited() {
      return managed.rootVerdict === 'exited'
    },
    spawned,
    onExit: (listener) => managed.onExit(() => listener()),
    stderrTail: () => managed.stderrTail().trim(),
    close: async () => (await managed.close()).root === 'exited',
    get treeUnproven() {
      const result = managed.lastCloseResult
      return result?.root === 'exited' && result.tree === 'unverifiable'
    }
  }
}
