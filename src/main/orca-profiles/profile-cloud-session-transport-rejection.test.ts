import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaCloudAuthConfig } from './profile-cloud-auth-config'
import type * as ProfileCloudClient from './profile-cloud-client'
import type { ActiveOrcaProfileState } from './profile-index-store'

const { readMock, clearMock, refreshMock } = vi.hoisted(() => ({
  readMock: vi.fn(),
  clearMock: vi.fn(),
  refreshMock: vi.fn()
}))

vi.mock('./profile-cloud-session-store', () => ({
  readOrcaCloudSession: readMock,
  saveOrcaCloudSessionIfCurrent: vi.fn(() => 'memory-only'),
  clearOrcaCloudSession: clearMock
}))

vi.mock('./profile-cloud-session-mutation', () => ({
  captureCloudSessionMutation: vi.fn(() => ({ epoch: 1, identityKey: 'identity' })),
  cloudSessionIdentity: vi.fn(() => ({})),
  tombstoneCloudSession: vi.fn()
}))

vi.mock('./profile-cloud-client', async (importOriginal) => {
  const original = await importOriginal<typeof ProfileCloudClient>()
  return { ...original, refreshOrcaCloudSession: refreshMock }
})

vi.mock('./profile-cloud-index', () => ({ linkOrcaProfileToCloud: vi.fn() }))

import { OrcaCloudRequestError, refreshOrcaCloudCapabilities } from './profile-cloud-client'
import { forgetAmbiguousRefreshAttempt } from './profile-cloud-refresh-replay-guard'
import {
  readFreshOrcaCloudSession,
  runWithFreshOrcaCloudSession
} from './profile-cloud-session-refresh'

const config: OrcaCloudAuthConfig = {
  apiBaseUrl: 'https://orca-cloud.example',
  authorizeEndpoint: 'https://orca-cloud.example/authorize',
  sessionEndpoint: 'https://orca-cloud.example/session',
  refreshEndpoint: 'https://orca-cloud.example/refresh',
  capabilitiesEndpoint: 'https://orca-cloud.example/capabilities',
  profileEndpoint: 'https://orca-cloud.example/profile',
  orgEndpoint: 'https://orca-cloud.example/org',
  logoutEndpoint: 'https://orca-cloud.example/logout',
  relayTokenEndpoint: 'https://orca-cloud.example/relay-token',
  relayDirectorUrl: 'https://relay.example',
  clientId: 'desktop-client',
  scope: 'openid'
}
const profile = {
  id: 'profile-1',
  name: 'Profile',
  avatar: { kind: 'initials', initials: 'P', color: 'neutral' },
  kind: 'cloud-linked',
  createdAt: 1,
  updatedAt: 1,
  lastOpenedAt: 1,
  cloud: {
    userId: 'user-1',
    cloudProfileId: 'cloud-profile-1',
    email: 'user@example.com',
    activeOrgId: 'org-1',
    linkedAt: 1
  }
} as const satisfies ActiveOrcaProfileState['profile']
const active: ActiveOrcaProfileState = {
  index: { schemaVersion: 1, activeProfileId: 'profile-1', profiles: [profile] },
  profile,
  dataFile: '/data/profile-1/orca-data.json',
  stateDatabaseFile: '/data/profile-1/state.db',
  profileDirectory: '/data/profile-1'
}
const staleSession = {
  accessToken: 'old-access',
  refreshToken: 'one-use-refresh',
  expiresAt: 1,
  organizations: [],
  capabilities: { flags: {}, refreshedAt: 1 }
}

// A proxy, captive portal or firewall answering 401/403 must not sign the user out.
describe('Orca Cloud auth rejections from something other than Orca Cloud', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    forgetAmbiguousRefreshAttempt('/data\0profile-1')
    readMock.mockReturnValue({ status: 'found', session: staleSession, persistence: 'memory-only' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps only an Orca Cloud error code on a 401/403', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(
      new Response('<html>Access denied</html>', {
        status: 403,
        headers: { 'content-type': 'text/html' }
      })
    )
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'invalid_token' }, { status: 401 }))
    fetchMock.mockResolvedValueOnce(
      Response.json({ code: 'invalid_access_token' }, { status: 401 })
    )

    for (const expected of [undefined, 'invalid_token', 'invalid_access_token']) {
      const error: unknown = await refreshOrcaCloudCapabilities(config, staleSession).catch(
        (caught: unknown) => caught
      )
      expect(error).toBeInstanceOf(OrcaCloudRequestError)
      expect(error).toHaveProperty('errorCode', expected)
    }
  })

  it('keeps the session and holds the possibly-spent refresh token back from replay', async () => {
    refreshMock.mockRejectedValue(new OrcaCloudRequestError(403))

    await expect(readFreshOrcaCloudSession(config, active, '/data')).rejects.toThrow(
      'orca_cloud_request_failed_403'
    )
    // The middlebox may have forwarded the request, so the token is treated as possibly spent.
    await expect(readFreshOrcaCloudSession(config, active, '/data')).rejects.toThrow(
      'orca_cloud_refresh_replay_blocked'
    )

    expect(refreshMock).toHaveBeenCalledTimes(1)
    expect(clearMock).not.toHaveBeenCalled()
  })

  it('still signs out on Orca Cloud rejecting the refresh token', async () => {
    refreshMock.mockRejectedValue(new OrcaCloudRequestError(401, 'invalid_refresh_token'))

    await expect(readFreshOrcaCloudSession(config, active, '/data')).resolves.toEqual({
      status: 'reconnect-required'
    })
    expect(clearMock).toHaveBeenCalledTimes(1)
  })

  it('surfaces an operation answered by a middlebox 401 without refreshing or signing out', async () => {
    readMock.mockReturnValue({
      status: 'found',
      session: { ...staleSession, expiresAt: Date.now() + 600_000 },
      persistence: 'memory-only'
    })
    const operation = vi.fn(async () => {
      throw new OrcaCloudRequestError(401)
    })

    await expect(runWithFreshOrcaCloudSession(config, active, '/data', operation)).rejects.toThrow(
      'orca_cloud_request_failed_401'
    )
    expect(operation).toHaveBeenCalledTimes(1)
    expect(refreshMock).not.toHaveBeenCalled()
    expect(clearMock).not.toHaveBeenCalled()
  })
})
