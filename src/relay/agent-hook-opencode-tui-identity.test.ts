import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RelayAgentHookServer } from './agent-hook-server'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'
import { makePaneKey } from '../shared/stable-pane-id'

const PANE_A = makePaneKey('tab-a', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
const PANE_B = makePaneKey('tab-b', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
const PANE_C = makePaneKey('tab-c', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')

describe('legacy TUI identity admitted by the execution-host relay', () => {
  let dir: string
  let server: RelayAgentHookServer
  const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
  const retired = new Set<string>()

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'relay-opencode-tui-'))
    forward.mockClear()
    retired.clear()
    server = new RelayAgentHookServer({
      endpointDir: dir,
      forward,
      isPaneSurfaceRetired: (paneKey) => retired.has(paneKey)
    })
    await server.start()
  })
  afterEach(() => {
    server.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  async function post(
    paneKey: string,
    sessionID: string,
    hookEventName = 'SessionBusy',
    extra: Record<string, unknown> = {}
  ) {
    const { port, token } = server.getCoordinates()
    const response = await fetch(`http://127.0.0.1:${port}/hook/opencode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
      body: JSON.stringify({
        paneKey,
        tabId: paneKey.split(':')[0],
        worktreeId: 'folder::same-folder',
        opencodeTui: 1,
        payload: { hook_event_name: hookEventName, sessionID },
        ...extra
      })
    })
    expect(response.status).toBe(204)
  }

  it('keeps overlapping pane statuses independent through forwarding and replay', async () => {
    await post(PANE_A, 'ses_a')
    await post(PANE_B, 'ses_b')
    forward.mockClear()
    await post(PANE_A, 'ses_b', 'SessionIdle', { opencodeTui: undefined, opencodeSharedServer: 1 })
    expect(forward).not.toHaveBeenCalled()
    await post(PANE_B, 'ses_b', 'SessionIdle')
    expect(forward.mock.calls[0][0]).toMatchObject({
      paneKey: PANE_B,
      payload: { state: 'done' }
    })
    forward.mockClear()
    expect(server.replayCachedPayloadsForPanes()).toBe(2)
    expect(forward.mock.calls.map(([event]) => [event.paneKey, event.payload.state])).toEqual([
      [PANE_A, 'working'],
      [PANE_B, 'done']
    ])
  })

  it('keeps the session creator when another pane views the same session', async () => {
    await post(PANE_A, 'ses_a')
    forward.mockClear()
    await post(PANE_B, 'ses_a')
    expect(forward.mock.calls[0][0].paneKey).toBe(PANE_A)
    expect(server.replayCachedPayloadsForPanes()).toBe(1)
  })

  it.each(['SessionIdle', 'PermissionRequest', 'MessagePart'] as const)(
    'rejects a retired physical viewer before attributing its late %s to a live creator',
    async (hookEventName) => {
      await post(PANE_B, 'ses_b', 'SessionBusy', { launchToken: 'creator-live' })
      await post(PANE_C, 'ses_c', 'SessionBusy', { launchToken: 'viewer-old' })
      retired.add(PANE_C)
      server.clearPaneState(PANE_C)
      forward.mockClear()
      await post(PANE_C, 'ses_b', hookEventName, {
        launchToken: 'viewer-old',
        payload: {
          hook_event_name: hookEventName,
          sessionID: 'ses_b',
          role: 'assistant',
          text: 'late viewer text',
          permission: 'bash',
          requestID: 'late-request'
        }
      })
      expect(forward).not.toHaveBeenCalled()
      expect(server.replayCachedPayloadsForPanes()).toBe(1)
      expect(forward.mock.calls[0][0]).toMatchObject({
        paneKey: PANE_B,
        launchToken: 'creator-live',
        payload: { state: 'working' }
      })
      retired.delete(PANE_C)
      forward.mockClear()
      await post(PANE_C, 'ses_b', 'SessionIdle', { launchToken: 'viewer-new' })
      expect(forward.mock.calls[0][0]).toMatchObject({
        paneKey: PANE_B,
        launchToken: 'creator-live',
        payload: { state: 'done' }
      })
    }
  )

  it('learns no identity from a rejected retired surface and admits its replacement', async () => {
    retired.add(PANE_B)
    await post(PANE_B, 'ses_old')
    expect(forward).not.toHaveBeenCalled()
    retired.delete(PANE_B)
    await post(PANE_A, 'ses_old', 'SessionIdle', {
      opencodeTui: undefined,
      opencodeSharedServer: 1
    })
    expect(forward).not.toHaveBeenCalled()
    await post(PANE_B, 'ses_new')
    expect(forward.mock.calls[0][0].paneKey).toBe(PANE_B)
    retired.add(PANE_B)
    server.clearPaneState(PANE_B)
    await post(PANE_B, 'ses_new', 'SessionIdle')
    forward.mockClear()
    expect(server.replayCachedPayloadsForPanes()).toBe(0)
    retired.delete(PANE_B)
    await post(PANE_B, 'ses_rebound')
    expect(forward.mock.calls[0][0]).toMatchObject({
      paneKey: PANE_B,
      providerSession: { id: 'ses_rebound' },
      payload: { state: 'working' }
    })
  })
})
