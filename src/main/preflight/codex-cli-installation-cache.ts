import type { CodexCliInstallation } from '../../shared/codex-cli-installation'

type CacheEntry = { fingerprint: string; expiresAt: number; result: Promise<CodexCliInstallation> }

export class CodexCliInstallationCache {
  private readonly entries = new Map<string, CacheEntry>()

  async read(
    host: string,
    fingerprint: string,
    probe: () => Promise<CodexCliInstallation>
  ): Promise<CodexCliInstallation> {
    const existing = this.entries.get(host)
    if (existing?.fingerprint === fingerprint && existing.expiresAt > Date.now()) {
      return existing.result
    }
    const entry: CacheEntry = { fingerprint, expiresAt: Infinity, result: probe() }
    this.entries.set(host, entry)
    try {
      const result = await entry.result
      // Unknown probes must heal even when the binary did not change.
      entry.expiresAt = result.status === 'unknown' ? Date.now() + 30_000 : Infinity
      return result
    } catch (error) {
      if (this.entries.get(host) === entry) {
        this.entries.delete(host)
      }
      throw error
    } finally {
      if (this.entries.size > 128) {
        const oldest = this.entries.keys().next().value
        if (oldest !== undefined && oldest !== host) {
          this.entries.delete(oldest)
        }
      }
    }
  }
}
