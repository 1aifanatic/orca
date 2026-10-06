import { describe, expect, it } from 'vitest'
import { BROWSER_CLIENT_HOST_AUTHORITY_MISMATCH_CODE } from '../../shared/browser-client-host-protocol'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import {
  BrowserHostAnswerError,
  browserHostRefusal,
  isFinalBrowserHostRefusal
} from './browser-host-admission-recovery'

describe('isFinalBrowserHostRefusal', () => {
  it('is final only for a non-recoverable answer the runtime itself gave', () => {
    expect(isFinalBrowserHostRefusal(new BrowserHostAnswerError('unauthorized', 'revoked'))).toBe(
      true
    )
    expect(
      isFinalBrowserHostRefusal(
        browserHostRefusal('browser_client_page_reconciliation_unsupported', 'cannot reconcile')
      )
    ).toBe(true)
  })

  it.each([
    ['an unknown local error', new Error('Stale browser host page command')],
    ['a locally built client error', new RemoteRuntimeClientError('unauthorized', 'local')],
    ['a host-sent recoverable code', new BrowserHostAnswerError('runtime_unavailable', 'restart')],
    ['a host-sent capacity code', new BrowserHostAnswerError('runtime_busy', 'lease capacity')],
    [
      'a replaced runtime',
      new BrowserHostAnswerError(BROWSER_CLIENT_HOST_AUTHORITY_MISMATCH_CODE, 'replaced')
    ]
  ])('is not final for %s', (_label, error) => {
    expect(isFinalBrowserHostRefusal(error)).toBe(false)
  })
})
