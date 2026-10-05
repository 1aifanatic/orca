import type { JiraConnectionStatus, JiraSite, JiraViewer } from '../../../shared/jira-types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJiraViewer(value: unknown): JiraViewer | null {
  if (
    !isRecord(value) ||
    typeof value.accountId !== 'string' ||
    typeof value.displayName !== 'string'
  ) {
    return null
  }
  return {
    accountId: value.accountId,
    displayName: value.displayName,
    email: typeof value.email === 'string' || value.email === null ? value.email : null,
    ...(typeof value.avatarUrl === 'string' ? { avatarUrl: value.avatarUrl } : {})
  }
}

function parseJiraSite(value: unknown): JiraSite | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.siteUrl !== 'string' ||
    typeof value.displayName !== 'string' ||
    typeof value.accountId !== 'string'
  ) {
    return null
  }
  return {
    id: value.id,
    siteUrl: value.siteUrl,
    email: typeof value.email === 'string' ? value.email : '',
    displayName: value.displayName,
    accountId: value.accountId,
    ...(value.authType === 'cloud' || value.authType === 'server'
      ? { authType: value.authType }
      : {})
  }
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
// undefined; status fields are normalized before store readers can dereference them.
export function parseJiraConnectionStatus(value: unknown): JiraConnectionStatus {
  if (!isRecord(value) || typeof value.connected !== 'boolean') {
    return { connected: false, viewer: null }
  }
  const viewer = parseJiraViewer(value.viewer)
  const sites = Array.isArray(value.sites)
    ? value.sites.flatMap((site) => {
        const parsed = parseJiraSite(site)
        return parsed ? [parsed] : []
      })
    : undefined
  return {
    connected: value.connected,
    viewer,
    ...(sites === undefined ? {} : { sites }),
    ...(isOptionalSiteId(value.activeSiteId) && value.activeSiteId !== undefined
      ? { activeSiteId: value.activeSiteId }
      : {}),
    ...(isOptionalSiteId(value.selectedSiteId) && value.selectedSiteId !== undefined
      ? { selectedSiteId: value.selectedSiteId }
      : {}),
    ...(typeof value.credentialError === 'string'
      ? { credentialError: value.credentialError }
      : {}),
    ...(isOptionalCredentialProtection(value.credentialProtection) &&
    value.credentialProtection !== undefined
      ? { credentialProtection: value.credentialProtection }
      : {})
  }
}
