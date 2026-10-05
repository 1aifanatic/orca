import type { PreloadApi } from '../../../../preload/api-types'
import { callAbortableRuntimeEnvironment } from '../../runtime/abortable-runtime-environment-call'
import { readRuntimeJiraPayload } from '../../runtime/runtime-jira-payload-stream'
import { callRuntimeResult } from './web-runtime-calls'
import { requireActiveEnvironment, updateEnvironmentFromResponse } from './web-runtime-session'

export type WebJiraApi = PreloadApi['jira']

type WebJiraResult<K extends keyof WebJiraApi> = Awaited<ReturnType<WebJiraApi[K]>>

const JIRA_REQUEST_TIMEOUT_MS = 30_000

const jiraRequestAbortControllers = new Map<string, AbortController>()

function callJira<K extends keyof WebJiraApi>(
  method: K,
  args?: Parameters<WebJiraApi[K]>[0]
): Promise<WebJiraResult<K>> {
  return callRuntimeResult<WebJiraResult<K>>(`jira.${method}`, args)
}

// Why: the one-shot call cannot cancel host work; a subscription closes the host request on abort,
// freeing its slot in the paired runtime's shared Jira request pool.
async function callCancellableJira<K extends 'searchIssues' | 'lookupIssueSummary'>(
  method: K,
  params: unknown,
  requestId: string | undefined
): Promise<WebJiraResult<K>> {
  if (!requestId) {
    return callRuntimeResult<WebJiraResult<K>>(`jira.${method}`, params)
  }
  const environment = requireActiveEnvironment()
  const controller = new AbortController()
  jiraRequestAbortControllers.set(requestId, controller)
  try {
    const response = await callAbortableRuntimeEnvironment(
      environment.id,
      `jira.${method}`,
      params,
      JIRA_REQUEST_TIMEOUT_MS,
      controller.signal
    )
    updateEnvironmentFromResponse(environment, response)
    if (!response.ok) {
      throw Object.assign(new Error(response.error.message), { code: response.error.code })
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: jira.<method> returns the desktop IPC reply type; callRuntimeResult trusts the same contract.
    return response.result as WebJiraResult<K>
  } finally {
    if (jiraRequestAbortControllers.get(requestId) === controller) {
      jiraRequestAbortControllers.delete(requestId)
    }
  }
}

function cancelJiraRequest({ requestId }: { requestId: string }): Promise<void> {
  jiraRequestAbortControllers.get(requestId)?.abort()
  return Promise.resolve()
}

// Why: issue details inline authenticated images, so they stream in chunks under the socket cap.
async function readJiraPayload<K extends 'getIssue' | 'issueComments'>(
  streamMethod: string,
  args: unknown
): Promise<WebJiraResult<K>> {
  const target = { kind: 'environment', environmentId: requireActiveEnvironment().id } as const
  return readRuntimeJiraPayload<WebJiraResult<K>>(target, streamMethod, args)
}

export function createWebJiraApi(): WebJiraApi {
  const jiraApi = {
    connect: (args) => callJira('connect', args),
    disconnect: (args) => callJira('disconnect', args),
    selectSite: (args) => callJira('selectSite', args),
    status: () => callJira('status'),
    readStatus: () => callJira('readStatus'),
    testConnection: (args) => callJira('testConnection', args),
    searchIssues: ({ requestId, ...params }) =>
      callCancellableJira('searchIssues', params, requestId),
    cancelSearchIssues: cancelJiraRequest,
    listIssues: (args) => callJira('listIssues', args),
    getIssue: (args) => readJiraPayload<'getIssue'>('jira.getIssueStream', args),
    lookupIssueSummary: ({ requestId, ...params }) =>
      callCancellableJira('lookupIssueSummary', params, requestId),
    cancelIssueSummary: cancelJiraRequest,
    createIssue: (args) => callJira('createIssue', args),
    updateIssue: (args) => callJira('updateIssue', args),
    addIssueComment: (args) => callJira('addIssueComment', args),
    issueComments: (args) => readJiraPayload<'issueComments'>('jira.issueCommentsStream', args),
    listProjects: (args) => callJira('listProjects', args),
    listIssueTypes: (args) => callJira('listIssueTypes', args),
    listCreateFields: (args) => callJira('listCreateFields', args),
    listPriorities: (args) => callJira('listPriorities', args),
    listAssignableUsers: (args) => callJira('listAssignableUsers', args),
    // Why: the runtime has no project-scoped user search; use site search like remote desktop hosts do.
    listAssignableUsersForProject: ({ query, siteId }) =>
      callJira('searchUsers', { query, siteId }),
    searchUsers: (args) => callJira('searchUsers', args),
    listTransitions: (args) => callJira('listTransitions', args),
    getProjectStatusOrder: (args) => callJira('getProjectStatusOrder', args)
  } satisfies WebJiraApi
  return jiraApi
}
