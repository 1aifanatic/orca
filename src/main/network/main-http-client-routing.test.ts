import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import { artifactRequest } from '../artifacts/artifact-cloud-request'
import type { OrcaCloudAuthConfig } from '../orca-profiles/profile-cloud-auth-config'
import { refreshOrcaCloudSession } from '../orca-profiles/profile-cloud-client'
import { listOrcaCloudOrgMembers } from '../orca-profiles/profile-cloud-org-members-client'
import { RelayAssignRateGate } from '../runtime/relay/relay-assign-rate-gate'
import {
  exchangeRelayAuthorization,
  requestRelayAssignment
} from '../runtime/relay/relay-http-client'
import { setMainHttpClient, type MainHttpClient } from './http-client'

const config: OrcaCloudAuthConfig = {
  apiBaseUrl: 'https://orca-cloud.example',
  authorizeEndpoint: 'https://orca-cloud.example/v1/desktop/auth/authorize',
  sessionEndpoint: 'https://orca-cloud.example/v1/desktop/auth/session',
  refreshEndpoint: 'https://orca-cloud.example/v1/desktop/auth/refresh',
  capabilitiesEndpoint: 'https://orca-cloud.example/v1/desktop/auth/capabilities',
  profileEndpoint: 'https://orca-cloud.example/v1/desktop/auth/profile',
  orgEndpoint: 'https://orca-cloud.example/v1/desktop/auth/org',
  logoutEndpoint: 'https://orca-cloud.example/v1/desktop/auth/logout',
  relayTokenEndpoint: 'https://orca-cloud.example/v1/desktop/auth/relay-token',
  relayDirectorUrl: 'https://relay.example',
  clientId: 'desktop-client',
  scope: 'openid profile email offline_access'
}

const session = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresAt: 999,
  capabilities: { flags: {}, refreshedAt: 1 }
}

// Why: Node's global fetch ignores the desktop's system/PAC proxy; these calls must use the port.
describe('relay and Orca Cloud HTTP use the main HTTP client', () => {
  const portFetch = vi.fn<MainHttpClient['fetch']>()
  const globalFetch = vi.fn(async () => {
    throw new Error('global fetch bypasses the desktop proxy')
  })

  beforeEach(() => {
    portFetch.mockReset()
    vi.stubGlobal('fetch', globalFetch)
    setMainHttpClient({ fetch: portFetch, proxySession: () => null })
  })

  afterEach(() => {
    setMainHttpClient(null)
    vi.unstubAllGlobals()
  })

  it('routes the relay token exchange and assignment', async () => {
    const keypair = nacl.box.keyPair()
    portFetch.mockResolvedValueOnce(
      Response.json({ relayToken: 'relay-token', expiresAt: Date.now() + 300_000 })
    )
    await exchangeRelayAuthorization({
      endpoint: config.relayTokenEndpoint,
      accessToken: 'access-token',
      keypair: { ...keypair, publicKeyB64: Buffer.from(keypair.publicKey).toString('base64') }
    })
    portFetch.mockResolvedValueOnce(
      Response.json({ v: 1, cellUrl: 'https://relay-c1.example', assignmentEpoch: 1, lease: 'l' })
    )
    await requestRelayAssignment({
      directorUrl: config.relayDirectorUrl,
      relayToken: 'relay-token',
      relayHostId: 'AbCdEf0123_-xyZ9',
      assignRateGate: new RelayAssignRateGate()
    })

    expect(portFetch.mock.calls.map(([url]) => url)).toEqual([
      config.relayTokenEndpoint,
      'https://relay.example/v1/assign'
    ])
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it('routes Orca Cloud auth, org, and artifact requests', async () => {
    portFetch.mockResolvedValueOnce(
      Response.json({
        accessToken: 'next-access',
        refreshToken: 'next-refresh',
        expiresAt: 2_000,
        cloud: { cloudProfileId: 'cloud-profile-1', userId: 'user-1', email: 'a@example.com' },
        organizations: [],
        capabilities: { flags: {} }
      })
    )
    await refreshOrcaCloudSession(config, session)
    portFetch.mockResolvedValueOnce(Response.json({ members: [], invites: [] }))
    await listOrcaCloudOrgMembers(config, session, 'org-1').catch(() => undefined)
    portFetch.mockResolvedValueOnce(Response.json({ items: [] }))
    await artifactRequest('https://orca-cloud.example', 'access-token', '/mine')

    expect(portFetch.mock.calls.map(([url]) => url)).toEqual([
      config.refreshEndpoint,
      'https://orca-cloud.example/v1/desktop/orgs/org-1/members',
      'https://orca-cloud.example/v1/artifacts/mine'
    ])
    expect(globalFetch).not.toHaveBeenCalled()
  })
})
