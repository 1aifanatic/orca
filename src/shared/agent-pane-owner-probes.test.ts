import { describe, expect, it, vi } from 'vitest'
import type { AgentProcessVerdict } from './agent-process-presence'
import {
  HELD_GUEST_WINDOW_MS,
  OWNER_PROBE_COOLDOWN_MS,
  PaneOwnerProbes
} from './agent-pane-owner-probes'

const OWNER = { pid: 4001, platform: 'linux' as const, startTime: 'boot:1' }

function setup(verdict: AgentProcessVerdict | null = 'live') {
  let now = 1_000
  const checkOwner = vi.fn(async () => verdict)
  const probes = new PaneOwnerProbes({ checkOwner, now: () => now })
  return {
    probes,
    checkOwner,
    advance: (ms: number) => {
      now += ms
    }
  }
}

describe('PaneOwnerProbes', () => {
  it('checks one owner once per window, and again after it', () => {
    const { probes, checkOwner, advance } = setup()
    for (let index = 0; index < 5; index += 1) {
      probes.guest('pane', { producer: 'codex', holdable: true, apply: vi.fn() }, OWNER)
    }
    expect(checkOwner).toHaveBeenCalledOnce()
    advance(OWNER_PROBE_COOLDOWN_MS)
    probes.guest('pane', { producer: 'codex', holdable: true, apply: vi.fn() }, OWNER)
    expect(checkOwner).toHaveBeenCalledTimes(2)
  })

  it('applies only the latest event of the guest that started the probe', async () => {
    const { probes } = setup('exited')
    const first = vi.fn()
    const latest = vi.fn()
    const other = vi.fn()
    probes.guest('pane', { producer: 'codex', holdable: true, apply: first }, OWNER)
    probes.guest('pane', { producer: 'codex', holdable: true, apply: latest }, OWNER)
    probes.guest('pane', { producer: 'gemini', holdable: true, apply: other }, OWNER)
    await vi.waitFor(() => expect(latest).toHaveBeenCalledOnce())
    expect(first).not.toHaveBeenCalled()
    expect(other).not.toHaveBeenCalled()
  })

  it('applies nothing when the probe was not started by the held guest', async () => {
    const { probes, checkOwner } = setup('exited')
    const apply = vi.fn()
    probes.probe('pane', OWNER)
    probes.guest('pane', { producer: 'codex', holdable: true, apply }, OWNER)
    await vi.waitFor(() => expect(checkOwner).toHaveBeenCalledOnce())
    await Promise.resolve()
    expect(apply).not.toHaveBeenCalled()
  })

  it('drops a held event older than the window', async () => {
    let release: (verdict: AgentProcessVerdict) => void = () => {}
    let now = 0
    const probes = new PaneOwnerProbes({
      checkOwner: () =>
        new Promise((resolve) => {
          release = resolve
        }),
      now: () => now
    })
    const apply = vi.fn()
    probes.guest('pane', { producer: 'codex', holdable: true, apply }, OWNER)
    now += HELD_GUEST_WINDOW_MS + 1
    release('exited')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(apply).not.toHaveBeenCalled()
  })
})
