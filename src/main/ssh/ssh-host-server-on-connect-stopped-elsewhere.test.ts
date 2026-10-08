import { describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import { recheckFencedManagedServer } from './managed-server-fence-recheck'
import { withDeactivatedVersion, type OrcadActivationRecord } from './orcad-activation-record'
import { planManagedOrcadAutoUpdate } from './orcad-managed-auto-update'
import {
  MANAGED_ORCAD_FENCED_DETAIL,
  MANAGED_ORCAD_NOT_ACTIVATED_DETAIL
} from './orcad-managed-serving'
import { resolveHostServerOnConnect } from './ssh-host-server-on-connect'
import { hostServerDepsStub } from './ssh-host-server-on-connect-test-deps'

const target: SshTarget = { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me' }

const notActivated = vi.fn(async () => ({
  state: 'unverifiable' as const,
  detail: MANAGED_ORCAD_NOT_ACTIVATED_DETAIL
}))

describe('a linked server another desktop stopped (P1-D)', () => {
  it('is redeployed through the update on connect instead of staying stranded', async () => {
    const d = hostServerDepsStub({
      managedEnvironmentId: () => 'env-9',
      ensureServing: notActivated,
      autoUpdate: vi.fn(async (_id, options) => {
        options.onUpdating()
        return { outcome: 'updated' as const, activeVersion: '2' }
      })
    })
    await expect(resolveHostServerOnConnect(target, d)).resolves.toEqual({
      route: 'managed',
      environmentId: 'env-9'
    })
    expect(d.autoUpdate).toHaveBeenCalledWith('env-9', expect.anything())
    expect(d.progress).toHaveBeenCalledWith(target, 'updating')
    expect(d.relayTerminals).not.toHaveBeenCalled()
  })

  it('keeps the not-activated note when the redeploy did not run', async () => {
    const d = hostServerDepsStub({
      managedEnvironmentId: () => 'env-9',
      ensureServing: notActivated,
      autoUpdate: vi.fn(async () => ({ outcome: 'failed' as const, reason: 'upload failed' }))
    })
    await expect(resolveHostServerOnConnect(target, d)).resolves.toEqual({
      route: 'managed',
      environmentId: 'env-9',
      update: { state: 'failed', detail: 'upload failed' },
      serving: { state: 'unverifiable', detail: MANAGED_ORCAD_NOT_ACTIVATED_DETAIL }
    })
  })

  it('still skips the update for a server that is unverifiable for any other reason', async () => {
    const d = hostServerDepsStub({
      managedEnvironmentId: () => 'env-9',
      ensureServing: vi.fn(async () => ({
        state: 'unverifiable' as const,
        detail: MANAGED_ORCAD_FENCED_DETAIL
      }))
    })
    await expect(resolveHostServerOnConnect(target, d)).resolves.toMatchObject({
      fenceHeld: true
    })
    expect(d.autoUpdate).not.toHaveBeenCalled()
  })

  it('is redeployed by the fence recheck too', async () => {
    const d = hostServerDepsStub({
      ensureServing: notActivated,
      autoUpdate: vi.fn(async () => ({ outcome: 'updated' as const, activeVersion: '2' }))
    })
    await expect(recheckFencedManagedServer(target, 'env-9', d)).resolves.toEqual({
      route: 'managed',
      environmentId: 'env-9'
    })
  })

  it('plans an update for the record a stop leaves behind', () => {
    const served: OrcadActivationRecord = {
      schemaVersion: 1,
      active: '1.0.0+abc',
      previous: null,
      activatedAt: '2026-10-01T00:00:00.000Z',
      activeAppVersion: '1.0.0',
      snapshot: null
    }
    expect(
      planManagedOrcadAutoUpdate({
        record: withDeactivatedVersion(served),
        candidateVersion: '1.0.0+abc',
        appVersion: '1.0.0',
        failedBefore: false
      })
    ).toEqual({ action: 'update' })
  })
})
