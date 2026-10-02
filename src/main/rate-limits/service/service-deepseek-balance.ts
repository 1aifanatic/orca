import type { DeepSeekCredentials } from '../../deepseek/deepseek-credentials'
import { unsupportedDeepSeekAccount } from '../../../shared/deepseek-balance'
import { deepSeekBalanceFailure, fetchDeepSeekBalance } from '../deepseek-fetcher'
import { RateLimitServiceFetchPolicy } from './service-fetch-policy'
import type { RateLimitState } from './service-types'

export abstract class RateLimitServiceDeepSeekBalance extends RateLimitServiceFetchPolicy {
  protected deepseekCredentials: DeepSeekCredentials | null = null
  private deepseekGeneration = 0
  private deepseekFetch: Promise<RateLimitState> | null = null
  private deepseekRevision: string | null | undefined

  setDeepSeekCredentials(credentials: DeepSeekCredentials): void {
    if (this.deepseekCredentials) {
      throw new Error('DeepSeek credential owner is immutable')
    }
    this.deepseekCredentials = credentials
    this.pushToRenderer()
  }

  getDeepSeekAccountStatus(probeProtection = true): ReturnType<DeepSeekCredentials['getStatus']> {
    const status =
      this.deepseekCredentials?.getStatus(probeProtection) ?? unsupportedDeepSeekAccount()
    if (probeProtection) {
      this.pushToRenderer()
    }
    return status
  }

  saveDeepSeekApiKey(
    ownerId: string,
    apiKey: string
  ): ReturnType<DeepSeekCredentials['getStatus']> {
    if (!this.deepseekCredentials) {
      throw new Error('DeepSeek accounts are unsupported on this host')
    }
    const status = this.deepseekCredentials.save(ownerId, apiKey)
    this.invalidateDeepSeekBalance()
    return status
  }

  removeDeepSeekApiKey(ownerId: string): ReturnType<DeepSeekCredentials['getStatus']> {
    if (!this.deepseekCredentials) {
      throw new Error('DeepSeek accounts are unsupported on this host')
    }
    const status = this.deepseekCredentials.remove(ownerId)
    this.invalidateDeepSeekBalance()
    return status
  }

  refreshDeepSeekBalance(signal?: AbortSignal): Promise<RateLimitState> {
    if (!this.deepseekFetch) {
      const controller = this.beginFetchCycle()
      const cycleSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
      this.deepseekFetch = this.runDeepSeekBalanceCycle(cycleSignal).finally(() => {
        this.finishFetchCycle(controller)
        this.deepseekFetch = null
      })
    }
    return this.deepseekFetch
  }

  private invalidateDeepSeekBalance(): void {
    this.deepseekGeneration += 1
    this.updateState({ ...this.state, deepseek: null })
    // A superseded request must finish before the new credential is polled.
    const pending = this.deepseekFetch ?? Promise.resolve()
    void pending.then(() => this.refreshDeepSeekBalance()).catch(() => undefined)
  }

  private async runDeepSeekBalanceCycle(signal?: AbortSignal): Promise<RateLimitState> {
    const credentials = this.deepseekCredentials
    const generation = this.deepseekGeneration
    const revision = credentials?.revision()
    const previous = revision === this.deepseekRevision ? this.state.deepseek : null
    if (revision !== this.deepseekRevision) {
      this.deepseekRevision = revision
      this.updateState({ ...this.state, deepseek: null })
    }
    let fresh = deepSeekBalanceFailure(
      'DeepSeek accounts are unsupported on this host',
      'usage-unavailable',
      'unavailable'
    )
    if (credentials && !credentials.getStatus(false).configured) {
      fresh = await fetchDeepSeekBalance(null, signal)
    } else if (credentials?.getStatus().supported) {
      try {
        fresh = await fetchDeepSeekBalance(credentials.read(), signal)
      } catch {
        fresh = deepSeekBalanceFailure(
          'DeepSeek API key could not be read from protected storage',
          'keychain-unavailable'
        )
      }
    }
    if (revision !== credentials?.revision()) {
      this.updateState({ ...this.state, deepseek: null })
    } else if (
      !signal?.aborted &&
      generation === this.deepseekGeneration &&
      revision === credentials?.revision()
    ) {
      this.trackActiveFailureStreak('deepseek', fresh)
      this.updateState({ ...this.state, deepseek: this.applyStalePolicy(fresh, previous) })
    }
    return this.getState()
  }
}
