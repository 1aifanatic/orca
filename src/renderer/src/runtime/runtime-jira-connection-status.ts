import type { JiraConnectionStatus } from '../../../shared/jira-types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Why: a missing or malformed reply (e.g. another host version's) must store as disconnected, never undefined.
export function parseJiraConnectionStatus(value: unknown): JiraConnectionStatus {
  if (
    !isRecord(value) ||
    typeof value.connected !== 'boolean' ||
    !(value.viewer === undefined || value.viewer === null || isRecord(value.viewer)) ||
    !(value.sites === undefined || Array.isArray(value.sites))
  ) {
    return { connected: false, viewer: null }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `connected`, `viewer` and `sites`, the fields status readers dereference, are checked above.
  return { ...value, viewer: value.viewer ?? null } as JiraConnectionStatus
}
