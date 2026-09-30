import { describe, expect, it, vi } from 'vitest'
import {
  probeAgentProcessPresence,
  windowsAgentProcessReader
} from './agent-process-presence-probe'
const identity = { pid: 42, platform: 'win32', startTime: '123' } as const
describe('Windows native birth observation', () => {
  it('keeps missing and failed native reads unverifiable', async () => {
    for (const native of [
      () => null,
      () => {
        throw new Error('denied')
      }
    ]) {
      expect(
        await probeAgentProcessPresence(identity, windowsAgentProcessReader(native), 'win32')
      ).toBe('unverifiable')
    }
  })
  it('compares births without converting null into death', async () => {
    expect(
      await probeAgentProcessPresence(
        identity,
        windowsAgentProcessReader(() => 123),
        'win32'
      )
    ).toBe('live')
    expect(
      await probeAgentProcessPresence(
        identity,
        windowsAgentProcessReader(() => 124),
        'win32'
      )
    ).toBe('exited')
  })
  it('does not read a foreign host platform', async () => {
    const native = vi.fn(() => 123)
    expect(
      await probeAgentProcessPresence(identity, windowsAgentProcessReader(native), 'linux')
    ).toBe('unverifiable')
    expect(native).not.toHaveBeenCalled()
  })
})
