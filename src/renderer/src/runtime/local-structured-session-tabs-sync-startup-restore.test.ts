// @vitest-environment happy-dom

import { expect, it, vi } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import {
  restoreLocalStructuredSessionTabsOnce,
  startLocalStructuredSessionTabsSync
} from './local-structured-session-tabs-sync'

it('still subscribes when the startup restore it shares with hydration fails', async () => {
  const priorApi = window.api
  let answerFirstListing = (_response: unknown): void => undefined
  const firstListing = new Promise((resolve) => {
    answerFirstListing = resolve
  })
  const call = vi
    .fn()
    .mockReturnValueOnce(firstListing)
    .mockResolvedValue({ ok: true, result: { snapshots: [] } })
  const subscribe = vi.fn(async () => ({ unsubscribe: vi.fn() }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      runtime: {
        getStatus: vi.fn().mockResolvedValue({
          capabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
        }),
        call,
        subscribe
      }
    }
  })
  try {
    // Hydration fires the restore without waiting, then the sync joins that same attempt.
    void restoreLocalStructuredSessionTabsOnce().catch(() => undefined)
    const started = startLocalStructuredSessionTabsSync({
      isDisposed: () => false,
      setUnsubscribe: () => undefined
    })
    // The sync has joined the pending restore by now, so the failure reaches it too.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(call).toHaveBeenCalledOnce()
    answerFirstListing({ ok: false, error: { code: 'runtime_error', message: 'install failed' } })
    await started

    expect(subscribe).toHaveBeenCalledOnce()
  } finally {
    Object.defineProperty(window, 'api', { configurable: true, value: priorApi })
  }
})
