export class DaemonFreshSpawnAdmission {
  private recovery: Promise<boolean> | null = null
  private retryAfter = 0

  constructor(private probe: (() => Promise<boolean>) | null) {}

  get unavailable(): boolean {
    return this.probe !== null
  }

  recover(force = false): Promise<boolean> {
    if (!this.probe) {
      return Promise.resolve(true)
    }
    if (this.recovery) {
      return this.recovery
    }
    if (!force && Date.now() < this.retryAfter) {
      return Promise.resolve(false)
    }
    this.recovery = Promise.resolve()
      .then(this.probe)
      .catch(() => false)
      .then((healthy) => {
        if (healthy) {
          this.probe = null
        } else {
          this.retryAfter = Date.now() + 30_000
        }
        return healthy
      })
      .finally(() => {
        this.recovery = null
      })
    return this.recovery
  }
}
