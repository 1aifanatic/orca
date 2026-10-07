import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS,
  getTerminalPasteIngestMs
} from '../../shared/agent-prompt-injection'
import { createLaunchFallbackRuntime } from './agent-launch-fallback.test-fixture'
import { readTimedRuntimeFixture } from './agent-transcript-replay-test-harness'

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function settle(result: Promise<boolean>): Promise<boolean> {
  await vi.runAllTimersAsync()
  return result
}

describe('desktop launch after its real composer budget expires', () => {
  it.each(['cmd.exe', 'powershell.exe', 'pwsh.exe', null])(
    'writes zero bytes after a crash with foreground %s and unknown Windows proof',
    async (foregroundProcess) => {
      const rig = await createLaunchFallbackRuntime({
        process: { foregroundProcess, hasChildProcesses: false }
      })
      expect(await settle(rig.deliver())).toBe(false)
      expect(rig.fallback).toHaveBeenCalledOnce()
      expect(rig.writes).toEqual([])
      expect(rig.onComposerUnobserved).not.toHaveBeenCalled()
    }
  )

  it('keeps an unavailable inspection quiet when there is no positive evidence', async () => {
    const rig = await createLaunchFallbackRuntime({ unavailable: true })
    expect(await settle(rig.deliver())).toBe(false)
    expect(rig.writes).toEqual([])
  })

  it.each([false, true])(
    'accepts expected foreground through the %s legacy adapter',
    async (legacy) => {
      const rig = await createLaunchFallbackRuntime({
        legacy,
        process: { foregroundProcess: String.raw`C:\tools\opencode.exe`, hasChildProcesses: false }
      })
      expect(await settle(rig.deliver())).toBe(true)
      expect(rig.onComposerUnobserved).toHaveBeenCalledOnce()
      expect(rig.writes).toEqual(['\x1b[200~fix the conflict\rthen test\x1b[201~', '\r'])
      expect(rig.writeTimes[1] - rig.writeTimes[0]).toBe(
        AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS +
          getTerminalPasteIngestMs(process.platform, Buffer.byteLength(rig.writes[0], 'utf8'))
      )
    }
  )

  it('accepts an idle title even when the Windows/WSL process inspection is unavailable', async () => {
    const rig = await createLaunchFallbackRuntime({ unavailable: true })
    rig.runtime.onPtyData('pty-prompt', '\x1b]0;OpenCode idle\x07', Date.now())
    expect(await settle(rig.deliver())).toBe(true)
    expect(rig.inspectProcess).not.toHaveBeenCalled()
    expect(rig.onComposerUnobserved).toHaveBeenCalledOnce()
  })

  it('accepts weak child evidence on the fourth probe with a non-shell foreground', async () => {
    const rig = await createLaunchFallbackRuntime({
      process: { foregroundProcess: 'node', hasChildProcesses: true }
    })
    expect(await settle(rig.deliver())).toBe(true)
    expect(rig.inspectProcess).toHaveBeenCalledTimes(4)
    expect(rig.onComposerUnobserved).toHaveBeenCalledOnce()
  })

  it.each(['cmd.exe', 'powershell.exe', 'bash', null])(
    'never accepts children while %s is foreground',
    async (foregroundProcess) => {
      const rig = await createLaunchFallbackRuntime({
        process: { foregroundProcess, hasChildProcesses: true }
      })
      expect(await settle(rig.deliver())).toBe(false)
      expect(rig.inspectProcess.mock.calls.length).toBeGreaterThanOrEqual(4)
      expect(rig.writes).toEqual([])
    }
  )

  it('gives Codex no timeout fallback even with a matching foreground process', async () => {
    const rig = await createLaunchFallbackRuntime({
      agent: 'codex',
      process: { foregroundProcess: 'codex', hasChildProcesses: true }
    })
    expect(await settle(rig.deliver())).toBe(false)
    expect(rig.fallback).not.toHaveBeenCalled()
    expect(rig.writes).toEqual([])
  })

  it('delivers on a captured healthy composer without process capability or fallback', async () => {
    const rig = await createLaunchFallbackRuntime({ unavailable: true })
    const result = rig.deliver()
    await vi.advanceTimersByTimeAsync(0)
    const { chunks } = readTimedRuntimeFixture('opencode-cmd-2-0-21-timed-warm-server')
    for (const chunk of chunks) {
      rig.runtime.onPtyData('pty-prompt', chunk, Date.now())
    }
    expect(await settle(result)).toBe(true)
    expect(rig.fallback).not.toHaveBeenCalled()
    expect(rig.onComposerUnobserved).not.toHaveBeenCalled()
    expect(rig.writes).toHaveLength(2)
  })

  it.each(['device-1', 'trusted-local:runtime'])(
    'keeps %s on its existing composer path and unknown-proof refusal',
    async (callerKey) => {
      const rig = await createLaunchFallbackRuntime()
      rig.composer.mockResolvedValue({
        handle: rig.handle,
        condition: 'tui-idle',
        satisfied: true,
        status: 'running',
        exitCode: null
      })
      expect(await settle(rig.deliver({ callerKey }))).toBe(false)
      expect(rig.fallback).not.toHaveBeenCalled()
      expect(rig.writes).toEqual([])
    }
  )
})
