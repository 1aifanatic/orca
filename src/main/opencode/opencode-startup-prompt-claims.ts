import type { TerminalRunFacts } from '../runtime/terminal-run-facts'

type PromptClaim = {
  digest: string
  expiresAt: number
  readOwner: () => TerminalRunFacts | 'pending' | null
  cleanup: () => void
  expiry: ReturnType<typeof setTimeout>
}

/** A one-use launch authorization; the execution owner supplies the process facts. */
export class OpenCodeStartupPromptClaims {
  private readonly pending = new Map<string, PromptClaim>()

  constructor(private readonly now: () => number = Date.now) {}

  register(
    nonce: string,
    digest: string,
    readOwner: PromptClaim['readOwner'],
    cleanup = () => {}
  ): boolean {
    const now = this.now()
    for (const [key, claim] of this.pending) {
      if (claim.expiresAt <= now) {
        this.cancel(key)
      }
    }
    if (this.pending.size >= 128 || this.pending.has(nonce)) {
      return false
    }
    const expiry = setTimeout(() => this.cancel(nonce), 20000)
    expiry.unref?.()
    this.pending.set(nonce, { digest, readOwner, expiresAt: now + 20000, cleanup, expiry })
    return true
  }

  admit(nonce: string, readOwner: PromptClaim['readOwner'], cleanup = () => {}): boolean {
    const pending = this.pending.get(nonce)
    if (!pending || pending.expiresAt <= this.now()) {
      this.cancel(nonce)
      return false
    }
    pending.readOwner = readOwner
    pending.cleanup = cleanup
    return true
  }

  cancel(nonce: string): void {
    const pending = this.pending.get(nonce)
    this.pending.delete(nonce)
    if (pending) {
      clearTimeout(pending.expiry)
    }
    pending?.cleanup()
  }

  clear(): void {
    for (const nonce of this.pending.keys()) {
      this.cancel(nonce)
    }
  }

  claim(body: unknown): boolean | 'pending' {
    if (!body || typeof body !== 'object' || !('nonce' in body) || typeof body.nonce !== 'string') {
      return false
    }
    const pending = this.pending.get(body.nonce)
    if (
      !pending ||
      pending.expiresAt <= this.now() ||
      !('digest' in body) ||
      body.digest !== pending.digest
    ) {
      this.cancel(body.nonce)
      return false
    }
    const owner = pending.readOwner()
    if (owner === 'pending') {
      return 'pending'
    }
    this.cancel(body.nonce)
    return owner?.freshSpawn === true && owner.firstUserInputAt === null
  }
}
