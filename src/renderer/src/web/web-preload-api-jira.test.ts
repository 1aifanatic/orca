import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

type RuntimeCall = { method: string; params: unknown }
type SubscriptionCallbacks = {
  onResponse: (response: RuntimeRpcResponse<unknown>) => void
  onError?: (error: { code: string; message: string }) => void
  onClose?: () => void
}
type Subscription = RuntimeCall & { callbacks: SubscriptionCallbacks; unsubscribe: () => void }

function ok(result: unknown): RuntimeRpcResponse<unknown> {
  return { id: 'response-1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function mockRuntimeClient(results: Record<string, unknown> = {}): {
  calls: RuntimeCall[]
  subscriptions: Subscription[]
} {
  const calls: RuntimeCall[] = []
  const subscriptions: Subscription[] = []
  vi.doMock('./web-runtime-client', () => ({
    WebRuntimeClient: class {
      call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
        calls.push({ method, params })
        return Promise.resolve(ok(results[method] ?? null))
      }

      subscribe(
        method: string,
        params: unknown,
        callbacks: SubscriptionCallbacks
      ): Promise<{ unsubscribe: () => void }> {
        const subscription = { method, params, callbacks, unsubscribe: vi.fn() }
        subscriptions.push(subscription)
        return Promise.resolve({ unsubscribe: subscription.unsubscribe })
      }

      close(): void {}
    }
  }))
  return { calls, subscriptions }
}

async function installPairedWebApi() {
  const globals = installBrowserGlobals('Linux')
  writeStoredRuntimeEnvironment(globals.storage)
  const { installWebPreloadApi } = await import('./web-preload-api')
  installWebPreloadApi()
  // Why: wrap it; withFallback answers `then`, so a bare namespace would never resolve from an async fn.
  return { jira: globals.window.api.jira }
}

describe('web Jira preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
    vi.doUnmock('electron')
  })

  it('keeps the web Jira preload key set in parity with desktop preload', async () => {
    vi.doMock('electron', () => ({ ipcRenderer: { invoke: vi.fn() } }))
    const { jiraApi } = await import('../../../preload/api/jira-bridge')

    const { jira } = await installPairedWebApi()

    expect(Object.keys(jira).sort()).toEqual(Object.keys(jiraApi).sort())
  })

  it('reads status and other one-shot calls from the paired runtime', async () => {
    const status = { connected: true, viewer: { displayName: 'Ada', email: 'ada@example.com' } }
    const { calls } = mockRuntimeClient({ 'jira.status': status })
    const { jira } = await installPairedWebApi()

    await expect(jira.status()).resolves.toEqual(status)
    await jira.listIssues({ filter: 'assigned', limit: 5, siteId: 'all' })
    await jira.listAssignableUsersForProject({ projectIdOrKey: 'ENG', query: 'ad', siteId: 's1' })

    expect(calls).toEqual([
      { method: 'jira.status', params: undefined },
      { method: 'jira.listIssues', params: { filter: 'assigned', limit: 5, siteId: 'all' } },
      { method: 'jira.searchUsers', params: { query: 'ad', siteId: 's1' } }
    ])
  })

  it('cancels a superseded search by closing its runtime request', async () => {
    const { calls, subscriptions } = mockRuntimeClient()
    const { jira } = await installPairedWebApi()

    const search = jira.searchIssues({ jql: 'text ~ "a"', limit: 10, requestId: 'search-1' })
    await vi.waitFor(() => expect(subscriptions).toHaveLength(1))
    await jira.cancelSearchIssues({ requestId: 'search-1' })

    await expect(search).rejects.toMatchObject({ name: 'AbortError' })
    expect(subscriptions[0]).toMatchObject({
      method: 'jira.searchIssues',
      params: { jql: 'text ~ "a"', limit: 10 }
    })
    expect(subscriptions[0].params).not.toHaveProperty('requestId')
    expect(subscriptions[0].unsubscribe).toHaveBeenCalled()
    expect(calls).toEqual([])
  })

  it('resolves a summary lookup that was not cancelled', async () => {
    const { subscriptions } = mockRuntimeClient()
    const { jira } = await installPairedWebApi()

    const lookup = jira.lookupIssueSummary({ key: 'ENG-1', siteId: 's1', requestId: 'summary-1' })
    await vi.waitFor(() => expect(subscriptions).toHaveLength(1))
    subscriptions[0].callbacks.onResponse(ok({ key: 'ENG-1' }))

    await expect(lookup).resolves.toEqual({ key: 'ENG-1' })
    expect(subscriptions[0]).toMatchObject({
      method: 'jira.lookupIssueSummary',
      params: { key: 'ENG-1', siteId: 's1' }
    })
    // A late cancel for a settled request is a no-op.
    await expect(jira.cancelIssueSummary({ requestId: 'summary-1' })).resolves.toBeUndefined()
  })

  it('streams issue details in chunks so inline images fit under the socket cap', async () => {
    const { subscriptions } = mockRuntimeClient()
    const { jira } = await installPairedWebApi()

    const issue = jira.getIssue({ key: 'ENG-1', siteId: 's1' })
    await vi.waitFor(() => expect(subscriptions).toHaveLength(1))
    const payload = JSON.stringify({ key: 'ENG-1', description: 'x'.repeat(10) })
    subscriptions[0].callbacks.onResponse(ok({ type: 'chunk', content: payload.slice(0, 8) }))
    subscriptions[0].callbacks.onResponse(ok({ type: 'chunk', content: payload.slice(8) }))
    subscriptions[0].callbacks.onResponse(ok({ type: 'end' }))

    await expect(issue).resolves.toEqual({ key: 'ENG-1', description: 'x'.repeat(10) })
    expect(subscriptions[0]).toMatchObject({
      method: 'jira.getIssueStream',
      params: { key: 'ENG-1', siteId: 's1' }
    })
  })
})
