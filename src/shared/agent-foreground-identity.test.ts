import { describe, expect, it, vi } from 'vitest'
import { captureAgentForegroundIdentity } from './agent-foreground-identity'
import type { AgentProcessObservation } from './agent-process-presence-probe'

const live = { verdict: 'live', startTime: 'boot:100', zombie: false, foreground: true } as const

describe('execution-host foreground identity', () => {
  it.each(['claude', 'codex', 'gemini', 'cursor', 'pi', 'omp', 'aider'])(
    'captures %s without hook identity',
    async (agent) => {
      const foreground = vi.fn(async () => ({
        available: true,
        processName: agent === 'cursor' ? 'cursor-agent' : agent,
        processId: 4242,
        processStartTime: '100'
      }))
      const read = vi.fn(async () => live)
      expect(await captureAgentForegroundIdentity(foreground, read, 'linux')).toEqual({
        agent,
        process: { pid: 4242, platform: 'linux', startTime: 'boot:100' }
      })
      expect(foreground).toHaveBeenCalledTimes(1)
      expect(read.mock.calls).toEqual([[4242], [4242]])
    }
  )

  it.each([
    { available: false, processName: 'codex', processId: 42 },
    { available: true, processName: 'codex' },
    { available: true, processName: 'zsh', processId: 42 }
  ])('never captures a name-only fallback or shell: %j', async (observation) => {
    const read = vi.fn()
    expect(
      await captureAgentForegroundIdentity(async () => observation, read, 'linux')
    ).toBeUndefined()
    expect(read).not.toHaveBeenCalled()
  })

  it.each([undefined, '99', '100'])(
    'binds Windows cached identity to its creation marker %s',
    async (start) => {
      const read = vi.fn(async () => ({ ...live, startTime: '100' }))
      const result = await captureAgentForegroundIdentity(
        async () => ({
          available: true,
          processName: 'codex',
          processId: 42,
          processStartTime: start
        }),
        read,
        'win32'
      )
      if (start === '100') {
        expect(result).toMatchObject({ process: { pid: 42, startTime: '100' } })
      } else {
        expect(result).toBeUndefined()
      }
      expect(read).toHaveBeenCalledTimes(start === '100' ? 2 : 1)
    }
  )

  it('matches the local Darwin snapshot against the exact UTC identity', async () => {
    const started = new Date(2026, 8, 29, 12, 34, 56)
    const exact = started.toUTCString().replace(',', '').replace(' GMT', '')
    const read = vi.fn(async () => ({ ...live, startTime: exact }))
    const observed = {
      available: true,
      processName: 'codex',
      processId: 42,
      processStartTime: started.toString().slice(0, 24)
    }
    expect(
      await captureAgentForegroundIdentity(async () => observed, read, 'darwin')
    ).toMatchObject({ process: { pid: 42, startTime: exact } })
  })

  it.each([undefined, '99'])(
    'rejects missing or recycled cached start identity %s',
    async (start) => {
      const read = vi.fn(async () => live)
      expect(
        await captureAgentForegroundIdentity(
          async () => ({
            available: true,
            processName: 'codex',
            processId: 42,
            processStartTime: start
          }),
          read,
          'linux'
        )
      ).toBeUndefined()
      expect(read).toHaveBeenCalledTimes(1)
    }
  )

  it.each<AgentProcessObservation>([
    { ...live, startTime: 'boot:101' },
    { ...live, zombie: true },
    { ...live, foreground: false },
    { ...live, stopped: true },
    { verdict: 'exited' },
    { verdict: 'unverifiable' }
  ])('rejects changed or unprovable identity during capture: %j', async (second) => {
    const read = vi
      .fn<() => Promise<AgentProcessObservation>>()
      .mockResolvedValueOnce(live)
      .mockResolvedValueOnce(second)
    expect(
      await captureAgentForegroundIdentity(
        async () => ({
          available: true,
          processName: 'codex',
          processId: 4242,
          processStartTime: '100'
        }),
        read,
        'linux'
      )
    ).toBeUndefined()
  })
})
