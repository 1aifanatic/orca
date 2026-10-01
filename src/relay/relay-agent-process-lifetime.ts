import { terminateRelaySubprocessTree } from './subprocess-tree-termination'

type Child = Parameters<typeof terminateRelaySubprocessTree>[0]

/** Request timeout/cancellation is not evidence that its host child has closed. */
export class RelayAgentProcessLifetime {
  private fenced = false
  private readonly children = new Map<Child, Promise<void>>()
  private disposal: Promise<void> | null = null

  assertAdmission(): void {
    if (this.fenced) {
      throw new Error('relay_agent_execution_shutdown_fenced')
    }
  }

  track(child: Child): void {
    this.assertAdmission()
    // Why: no Promise.withResolvers — the relay bundle still targets Node 18 hosts.
    let resolveClosed!: () => void
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve
    })
    this.children.set(child, closed)
    // A late error after request timeout must not remove physical-close tracking or crash the host.
    const onError = () => {}
    child.on('error', onError)
    child.once('close', () => {
      child.off('error', onError)
      this.children.delete(child)
      resolveClosed()
    })
  }

  dispose(): Promise<void> {
    this.fenced = true
    if (this.disposal) {
      return this.disposal
    }
    const pending = [...this.children.entries()]
    for (const [child] of pending) {
      terminateRelaySubprocessTree(child)
    }
    this.disposal = Promise.all(pending.map(([, closed]) => closed)).then(() => {})
    return this.disposal
  }
}
