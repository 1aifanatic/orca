import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  JIRA_USER_FIELDS_RUNTIME_CAPABILITY,
  JIRA_USER_FIELDS_UPDATE_REQUIRED_MESSAGE,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
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

function failure(code: string, message: string): RuntimeRpcResponse<unknown> {
  return {
    id: 'response-1',
    ok: false,
    error: { code, message },
    _meta: { runtimeId: 'runtime-1' }
  }
}

function mockRuntimeClient(
  options: { results?: Record<string, unknown>; capabilities?: string[] } = {}
): { calls: RuntimeCall[]; subscriptions: Subscription[] } {
  const calls: RuntimeCall[] = []
  const subscriptions: Subscription[] = []
  const serverStatus = {
    runtimeId: 'runtime-1',
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
    capabilities: options.capabilities ?? [JIRA_USER_FIELDS_RUNTIME_CAPABILITY]
  }
  vi.doMock('./web-runtime-client', () => ({
    WebRuntimeClient: class {
      call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
        if (method === 'status.get') {
          return Promise.resolve(ok(serverStatus))
        }
        calls.push({ method, params })
        return Promise.resolve(ok(options.results?.[method] ?? null))
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

function streamPayload(subscription: Subscription, value: unknown): void {
  const payload = JSON.stringify(value)
  subscription.callbacks.onResponse(ok({ type: 'chunk', content: payload.slice(0, 8) }))
  subscription.callbacks.onResponse(ok({ type: 'chunk', content: payload.slice(8) }))
  subscription.callbacks.onResponse(ok({ type: 'end' }))
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

  it('reads status and other one-shot calls from the paired server', async () => {
    const status = { connected: true, viewer: { displayName: 'Ada', email: 'ada@example.com' } }
    const { calls } = mockRuntimeClient({ results: { 'jira.status': status } })
    const { jira } = await installPairedWebApi()

    await expect(jira.status()).resolves.toEqual(status)
    await jira.listIssues({ filter: 'assigned', limit: 5, siteId: 'all' })
    await jira.searchIssues({ jql: 'project = ENG', limit: 10 })
    await jira.listAssignableUsersForProject({ projectIdOrKey: 'ENG', query: 'ad', siteId: 's1' })

    expect(calls).toEqual([
      { method: 'jira.status', params: undefined },
      { method: 'jira.listIssues', params: { filter: 'assigned', limit: 5, siteId: 'all' } },
      { method: 'jira.searchIssues', params: { jql: 'project = ENG', limit: 10 } },
      { method: 'jira.searchUsers', params: { query: 'ad', siteId: 's1' } }
    ])
  })

  it('cancels a superseded search by closing its server request', async () => {
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

  it('keeps the server error message and code on a cancellable request', async () => {
    const { subscriptions } = mockRuntimeClient()
    const { jira } = await installPairedWebApi()

    const search = jira.searchIssues({ jql: 'bad jql', requestId: 'search-2' })
    await vi.waitFor(() => expect(subscriptions).toHaveLength(1))
    subscriptions[0].callbacks.onResponse(failure('runtime_error', 'Jira rejected the JQL (400)'))

    await expect(search).rejects.toMatchObject({
      message: 'Jira rejected the JQL (400)',
      code: 'runtime_error'
    })
  })

  it('streams issue details and comments in chunks so inline images fit under the socket cap', async () => {
    const { subscriptions } = mockRuntimeClient()
    const { jira } = await installPairedWebApi()

    const issue = jira.getIssue({ key: 'ENG-1', siteId: 's1' })
    await vi.waitFor(() => expect(subscriptions).toHaveLength(1))
    streamPayload(subscriptions[0], { key: 'ENG-1', description: 'x'.repeat(10) })
    await expect(issue).resolves.toEqual({ key: 'ENG-1', description: 'x'.repeat(10) })

    const comments = jira.issueComments({ key: 'ENG-1', siteId: 's1' })
    await vi.waitFor(() => expect(subscriptions).toHaveLength(2))
    streamPayload(subscriptions[1], [{ id: 'c1', body: 'hello there' }])
    await expect(comments).resolves.toEqual([{ id: 'c1', body: 'hello there' }])

    expect(subscriptions.map(({ method, params }) => ({ method, params }))).toEqual([
      { method: 'jira.getIssueStream', params: { key: 'ENG-1', siteId: 's1' } },
      { method: 'jira.issueCommentsStream', params: { key: 'ENG-1', siteId: 's1' } }
    ])
  })

  it('falls back to one-shot issue details on a server without payload streaming', async () => {
    const { calls, subscriptions } = mockRuntimeClient({
      results: { 'jira.getIssue': { key: 'ENG-1' } }
    })
    const { jira } = await installPairedWebApi()

    const issue = jira.getIssue({ key: 'ENG-1', siteId: 's1' })
    await vi.waitFor(() => expect(subscriptions).toHaveLength(1))
    subscriptions[0].callbacks.onResponse(failure('method_not_found', 'Unknown method'))

    await expect(issue).resolves.toEqual({ key: 'ENG-1' })
    expect(calls).toEqual([{ method: 'jira.getIssue', params: { key: 'ENG-1', siteId: 's1' } }])
  })

  it('refuses user-field creates on a server without the user-fields capability', async () => {
    const { calls } = mockRuntimeClient({ capabilities: [] })
    const { jira } = await installPairedWebApi()

    await expect(
      jira.createIssue({
        projectId: '10000',
        issueTypeId: '10001',
        title: 'Bug',
        customFields: { reporter: 'acc-1' },
        userFieldKeys: ['reporter']
      })
    ).rejects.toThrow(JIRA_USER_FIELDS_UPDATE_REQUIRED_MESSAGE)
    expect(calls).toEqual([])
  })
})
