import { open, realpath, stat } from 'node:fs/promises'
import { codexSupportsNoDaemon } from './codex-terminal-launch-policy'

type Evidence = { identity: string; supported: boolean; expiresAt: number }
type Probe = (executable: string) => Promise<string>

/** Lives only on the execution host. No capability received from a client is trusted. */
export class CodexExecutableCapability {
  private readonly cache = new Map<string, Evidence>()
  private readonly pending = new Map<string, Promise<boolean>>()

  constructor(private readonly probe: Probe) {}

  async supportsNoDaemon(executable: string): Promise<boolean> {
    try {
      const path = await realpath(executable)
      const before = await this.identity(path)
      const cacheable = await this.isNativeExecutable(path)
      const cached = cacheable ? this.cache.get(path) : undefined
      if (cached?.identity === before && cached.expiresAt > Date.now()) {
        return cached.supported
      }
      const key = `${path}\0${before}`
      const pending = this.pending.get(key)
      if (pending) {
        return pending
      }
      const task = this.observe(path, before, cacheable)
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

  private async isNativeExecutable(path: string): Promise<boolean> {
    const file = await open(path, 'r')
    try {
      const bytes = Buffer.alloc(4)
      await file.read(bytes, 0, 4, 0)
      // Launch scripts can select another binary without themselves changing.
      return (
        ['7f454c46', 'cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe'].includes(
          bytes.toString('hex')
        ) || bytes.subarray(0, 2).toString() === 'MZ'
      )
    } finally {
      await file.close()
    }
  }

  private async observe(path: string, before: string, cacheable: boolean): Promise<boolean> {
    try {
      const supported = codexSupportsNoDaemon(await this.probe(path))
      if (before !== (await this.identity(path))) {
        return false
      }
      if (this.cache.size >= 128) {
        this.cache.delete(this.cache.keys().next().value ?? '')
      }
      if (cacheable) {
        const evidence = {
          identity: before,
          supported,
          expiresAt: supported ? Infinity : Date.now() + 30_000
        }
        this.cache.set(path, evidence)
      }
      return supported
    } catch {
      return false
    }
  }
}
