import { realpath, stat } from 'node:fs/promises'
import { codexSupportsNoDaemon } from './codex-terminal-launch-policy'

type Evidence = { identity: string; supported: boolean; expiresAt: number }
/** `executable` is the canonical file; `invokedPath` is what the shell will run. */
type Probe = (executable: string, invokedPath: string) => Promise<string>

const MAX_EVIDENCE_ENTRIES = 128
// Why short: a failed or timed-out probe must not latch the shared-server fallback.
const NEGATIVE_EVIDENCE_MS = 30_000
// Why finite: a version-manager shim can select an older Codex without changing
// its own file, and a stale positive would pass it an unknown flag.
const POSITIVE_EVIDENCE_MS = 10 * 60_000

/** Lives only on the execution host. No capability received from a client is trusted. */
export class CodexExecutableCapability {
  private readonly cache = new Map<string, Evidence>()
  private readonly pending = new Map<string, Promise<boolean>>()

  constructor(private readonly probe: Probe) {}

  async supportsNoDaemon(executable: string): Promise<boolean> {
    try {
      const path = await realpath(executable)
      const before = await this.identity(path)
      const cached = this.cache.get(path)
      if (cached?.identity === before && cached.expiresAt > Date.now()) {
        return cached.supported
      }
      const key = `${path}\0${before}`
      const pending = this.pending.get(key)
      if (pending) {
        return pending
      }
      const task = this.observe(path, before, executable)
      this.pending.set(key, task)
      try {
        return await task
      } finally {
        this.pending.delete(key)
      }
    } catch {
      return false
    }
  }

  private async identity(path: string): Promise<string> {
    const info = await stat(path, { bigint: true })
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
  }

  private async observe(path: string, before: string, invokedPath: string): Promise<boolean> {
    try {
      const supported = codexSupportsNoDaemon(await this.probe(path, invokedPath))
      if (before !== (await this.identity(path))) {
        return false
      }
      // Why scripts are cached too: package-manager updates replace the launcher
      // file, and re-probing an interpreter on every launch is the slow path.
      this.cache.delete(path)
      if (this.cache.size >= MAX_EVIDENCE_ENTRIES) {
        this.cache.delete(this.cache.keys().next().value ?? '')
      }
      this.cache.set(path, {
        identity: before,
        supported,
        expiresAt: Date.now() + (supported ? POSITIVE_EVIDENCE_MS : NEGATIVE_EVIDENCE_MS)
      })
      return supported
    } catch {
      return false
    }
  }
}
