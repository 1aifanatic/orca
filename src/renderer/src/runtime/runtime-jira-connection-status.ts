import type { JiraConnectionStatus, JiraSite, JiraViewer } from '../../../shared/jira-types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJiraViewer(value: unknown): value is JiraViewer {
  return (
    isRecord(value) &&
    typeof value.accountId === 'string' &&
    typeof value.displayName === 'string' &&
    (typeof value.email === 'string' || value.email === null) &&
    (value.avatarUrl === undefined || typeof value.avatarUrl === 'string')
  )
}

function isJiraSite(value: unknown): value is JiraSite {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.siteUrl === 'string' &&
    typeof value.email === 'string' &&
    typeof value.displayName === 'string' &&
    typeof value.accountId === 'string' &&
    (value.authType === undefined || value.authType === 'cloud' || value.authType === 'server')
  )
}

function isOptionalSiteId(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string'
}

function isOptionalCredentialProtection(
  value: unknown
): value is 'sealed' | 'plaintext' | null | undefined {
  return value === undefined || value === null || value === 'sealed' || value === 'plaintext'
}

// Why: the paired web client has no Jira preload, so its fallback proxy resolves
// undefined; any reply the store's status comparisons can't read is disconnected.
export function parseJiraConnectionStatus(value: unknown): JiraConnectionStatus {
  const viewer = isRecord(value) ? value.viewer : undefined
  const sites = isRecord(value) ? value.sites : undefined
  if (
    !isRecord(value) ||
    typeof value.connected !== 'boolean' ||
    !(viewer === undefined || viewer === null || isJiraViewer(viewer)) ||
    !(sites === undefined || (Array.isArray(sites) && sites.every(isJiraSite))) ||
    !isOptionalSiteId(value.activeSiteId) ||
    !isOptionalSiteId(value.selectedSiteId) ||
    !(value.credentialError === undefined || typeof value.credentialError === 'string') ||
    !isOptionalCredentialProtection(value.credentialProtection)
  ) {
    return { connected: false, viewer: null }
  }
  return {
    connected: value.connected,
    viewer: viewer ?? null,
    ...(sites === undefined ? {} : { sites }),
    ...(value.activeSiteId === undefined ? {} : { activeSiteId: value.activeSiteId }),
    ...(value.selectedSiteId === undefined ? {} : { selectedSiteId: value.selectedSiteId }),
    ...(value.credentialError === undefined ? {} : { credentialError: value.credentialError }),
    ...(value.credentialProtection === undefined
      ? {}
      : { credentialProtection: value.credentialProtection })
  }
}
