import type { PreloadApi } from '../../../../preload/api-types'
import {
  jiraAddIssueComment,
  jiraConnect,
  jiraCreateIssue,
  jiraDisconnect,
  jiraGetIssue,
  jiraGetProjectStatusOrder,
  jiraIssueComments,
  jiraListAssignableUsers,
  jiraListAssignableUsersForProject,
  jiraListCreateFields,
  jiraListIssues,
  jiraListIssueTypes,
  jiraListPriorities,
  jiraListProjects,
  jiraListTransitions,
  jiraLookupIssueSummary,
  jiraReadStatus,
  jiraSearchIssues,
  jiraSearchUsers,
  jiraSelectSite,
  jiraStatus,
  jiraTestConnection,
  jiraUpdateIssue,
  type RuntimeJiraSettings
} from '../../runtime/runtime-jira-client'
import { requireActiveEnvironment, WEB_CLIENT_UNPAIRED_MESSAGE } from './web-runtime-session'

export type WebJiraApi = PreloadApi['jira']

const jiraRequestAbortControllers = new Map<string, AbortController>()

// Why: in the web client "local" is the paired server; target it as a remote server so Jira reuses
// that path's stream fallbacks, capability gates and cancellation instead of a second copy.
function pairedServer(): RuntimeJiraSettings {
  const activeRuntimeEnvironmentId = requireActiveEnvironment().id
  // Why: a blank id resolves to the 'local' target, which would call back into this adapter.
  if (!activeRuntimeEnvironmentId.trim()) {
    throw new Error(WEB_CLIENT_UNPAIRED_MESSAGE)
  }
  return { activeRuntimeEnvironmentId }
}

async function withRequestSignal<T>(
  requestId: string | undefined,
  run: (signal?: AbortSignal) => Promise<T>
): Promise<T> {
  if (!requestId) {
    return run()
  }
  const controller = new AbortController()
  jiraRequestAbortControllers.set(requestId, controller)
  try {
    return await run(controller.signal)
  } finally {
    if (jiraRequestAbortControllers.get(requestId) === controller) {
      jiraRequestAbortControllers.delete(requestId)
    }
  }
}

async function cancelJiraRequest({ requestId }: { requestId: string }): Promise<void> {
  jiraRequestAbortControllers.get(requestId)?.abort()
}

export function createWebJiraApi(): WebJiraApi {
  const jiraApi = {
    connect: async (args) => jiraConnect(pairedServer(), args),
    disconnect: async (args) => jiraDisconnect(pairedServer(), args?.siteId),
    selectSite: async ({ siteId }) => jiraSelectSite(pairedServer(), siteId),
    status: async () => jiraStatus(pairedServer()),
    readStatus: async () => jiraReadStatus(pairedServer()),
    testConnection: async (args) => jiraTestConnection(pairedServer(), args?.siteId),
    searchIssues: async ({ jql, limit, siteId, requestId }) =>
      withRequestSignal(requestId, (signal) =>
        jiraSearchIssues(pairedServer(), jql, limit, siteId, signal)
      ),
    cancelSearchIssues: cancelJiraRequest,
    listIssues: async (args) =>
      jiraListIssues(pairedServer(), args?.filter, args?.limit, args?.siteId),
    getIssue: async ({ key, siteId }) => jiraGetIssue(pairedServer(), key, siteId),
    lookupIssueSummary: async ({ key, siteId, requestId }) =>
      withRequestSignal(requestId, (signal) =>
        jiraLookupIssueSummary(pairedServer(), key, siteId, signal)
      ),
    cancelIssueSummary: cancelJiraRequest,
    createIssue: async (args) => jiraCreateIssue(pairedServer(), args),
    updateIssue: async ({ key, updates, siteId }) =>
      jiraUpdateIssue(pairedServer(), key, updates, siteId),
    addIssueComment: async ({ key, body, siteId }) =>
      jiraAddIssueComment(pairedServer(), key, body, siteId),
    issueComments: async ({ key, siteId }) => jiraIssueComments(pairedServer(), key, siteId),
    listProjects: async (args) => jiraListProjects(pairedServer(), args?.siteId),
    listIssueTypes: async ({ projectIdOrKey, siteId }) =>
      jiraListIssueTypes(pairedServer(), projectIdOrKey, siteId),
    listCreateFields: async ({ projectIdOrKey, issueTypeId, siteId }) =>
      jiraListCreateFields(pairedServer(), projectIdOrKey, issueTypeId, siteId),
    listPriorities: async (args) => jiraListPriorities(pairedServer(), args?.siteId),
    listAssignableUsers: async ({ key, query, siteId }) =>
      jiraListAssignableUsers(pairedServer(), key, query, siteId),
    listAssignableUsersForProject: async ({ projectIdOrKey, query, siteId }) =>
      jiraListAssignableUsersForProject(pairedServer(), projectIdOrKey, query, siteId),
    searchUsers: async (args) => jiraSearchUsers(pairedServer(), args?.query, args?.siteId),
    listTransitions: async ({ key, siteId }) => jiraListTransitions(pairedServer(), key, siteId),
    getProjectStatusOrder: async ({ projectKey, siteId }) =>
      jiraGetProjectStatusOrder(pairedServer(), projectKey, siteId)
  } satisfies WebJiraApi
  return jiraApi
}
