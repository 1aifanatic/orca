import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { encodePairingOffer, parsePairingCode } from '../../shared/pairing'
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import {
  DELEGATED_MOBILE_DEVICE_SYNC_METHOD,
  type DelegatedMobileDeviceSyncResult
} from '../../shared/delegated-mobile-device-contract'
import { MOBILE_RPC_METHOD_ALLOWLIST } from './runtime-rpc/runtime-rpc-mobile-method-allowlist'
import {
  authenticate,
  createReader,
  makeStore,
  send,
  type PairedSession,
  type ResponseReader
} from './paired-client-navigation-test-harness'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

const FIRST_FRAME_TIMEOUT_MS = 1_500
const ErrorCodeSchema = z.object({ error: z.object({ code: z.string() }) })

describe('delegated phone allowlist census', () => {
  const cleanups: (() => Promise<void> | void)[] = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup()
    }
  })

  it('every allowlisted method answers a delegated phone exactly as it answers a direct phone', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the navigation fixture store carries every surface the dispatcher reads here.
    const runtime = new OrcaRuntimeService(makeStore() as never)
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath: mkdtempSync(join(tmpdir(), 'orca-delegated-census-')),
      enableWebSocket: true,
      wsPort: 0
    })
    await server.start()
    cleanups.push(() => server.stop())

    const directOffer = server.createPairingOffer({
      address: '127.0.0.1',
      name: 'direct',
      scope: 'mobile'
    })
    if (!directOffer.available) {
      throw new Error('pairing unavailable')
    }
    const direct = parsePairingCode(directOffer.pairingUrl)!
    const desktopOffer = server.createPairingOffer({
      address: '127.0.0.1',
      name: 'Mac',
      scope: 'runtime'
    })
    if (!desktopOffer.available) {
      throw new Error('pairing unavailable')
    }
    const desktop = parsePairingCode(desktopOffer.pairingUrl)!
    const synced = await sendRemoteRuntimeRequest<DelegatedMobileDeviceSyncResult>(
      desktop,
      DELEGATED_MOBILE_DEVICE_SYNC_METHOD,
      { phones: [{ phoneKey: 'p', name: 'p via Mac' }] },
      5_000
    )
    if (!synced.ok) {
      throw new Error('sync failed')
    }
    const child = synced.result.devices[0]!
    const delegated = {
      ...desktop,
      deviceToken: child.token,
      pairedDeviceId: child.deviceId,
      scope: 'mobile' as const
    }

    const sessions: [PairedSession, ResponseReader][] = []
    for (const pairing of [direct, delegated]) {
      const session = await authenticate(encodePairingOffer(pairing))
      const reader = createReader(session)
      sessions.push([session, reader])
      cleanups.push(() => {
        reader.dispose()
        session.ws.close()
      })
    }
    const identities: [string, string][] = [
      [direct.deviceToken, '<token>'],
      [direct.pairedDeviceId!, '<device>'],
      [child.token, '<token>'],
      [child.deviceId, '<device>']
    ]
    const normalize = (response: Record<string, unknown> | 'no-first-frame'): string => {
      if (response === 'no-first-frame') {
        return response
      }
      const { _meta: _ignored, id: _id, ...rest } = response
      let text = JSON.stringify(rest)
      for (const [value, placeholder] of identities) {
        text = text.split(value).join(placeholder)
      }
      // Why: ready-stream ids embed the per-socket connection id and a server-wide counter.
      return text.replace(/-[0-9a-f]{16}-\d+"/g, '-<connection>-<n>"')
    }
    const firstFrame = (reader: ResponseReader, id: string) =>
      Promise.race([
        reader.next(id),
        new Promise<'no-first-frame'>((resolve) =>
          setTimeout(() => resolve('no-first-frame'), FIRST_FRAME_TIMEOUT_MS)
        )
      ])

    const mismatches: { method: string; direct: string; delegated: string }[] = []
    const outcomes = new Map<string, number>()
    const methods = [...MOBILE_RPC_METHOD_ALLOWLIST].sort()
    for (const method of methods) {
      const results = await Promise.all(
        sessions.map(([session, reader], index) => {
          const id = `${method}#${index}`
          send(session, { id, method, params: {} })
          return firstFrame(reader, id)
        })
      )
      const [directText, delegatedText] = results.map(normalize)
      const code =
        results[0] === 'no-first-frame'
          ? 'no-first-frame'
          : results[0]!.ok
            ? 'ok'
            : String(ErrorCodeSchema.safeParse(results[0]).data?.error.code)
      outcomes.set(code, (outcomes.get(code) ?? 0) + 1)
      if (directText !== delegatedText) {
        mismatches.push({ method, direct: directText!, delegated: delegatedText! })
      }
    }
    // Presence precondition: the probe reached handlers, not only a blanket refusal.
    expect(outcomes.get('ok')).toBeGreaterThan(0)
    expect(mismatches).toEqual([])
  }, 120_000)
})
