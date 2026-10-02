import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { AgentProcessPresence } from '../../shared/agent-process-presence'
import { makePaneKey } from '../../shared/stable-pane-id'

const leafId = '11111111-1111-4111-8111-111111111111'
const paneKey = makePaneKey('tab', leafId)
const owner = {
  agent: 'codex',
  process: { pid: 42, platform: 'linux', startTime: 'boot:42' }
} as const
const runtimes: OrcaRuntimeService[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    runtime.setPtyController(null)
  }
  vi.useRealTimers()
})
function fixture() {
  const publish = vi.fn()
  const capture = vi.fn<() => Promise<AgentProcessPresence | undefined>>().mockResolvedValue(owner)
  let rows: AgentStatusIpcPayload[] = []
  const runtime = new OrcaRuntimeService(null, undefined, {
    onForegroundAgentPresence: publish,
    getAgentProviderSessionRowsForPane: () => rows
  })
  runtimes.push(runtime)
  const controller = {
    write: () => true,
    kill: () => true,
    captureAgentPresence: capture,
    getForegroundProcess: async () => null
  }
  runtime.setPtyController(controller)
  runtime.registerPty('pty', 'folder', null, { tabId: 'tab', leafId })
  const data = (value: string) => runtime.onPtyData('pty', value, Date.now())
  return {
    runtime,
    capture,
    publish,
    controller,
    data,
    setRows: (value: AgentStatusIpcPayload[]) => {
      rows = value
    }
  }
}

describe('runtime foreground admission', () => {
  it('makes one read per long command and none for idle shells or completed commands', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.capture).not.toHaveBeenCalled()
    f.data('\x1b]133;C\x07')
    f.data('\x1b]133;C\x07')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.capture).toHaveBeenCalledTimes(1)
    expect(f.publish).toHaveBeenCalledWith(expect.objectContaining({ paneKey }), owner)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.capture).toHaveBeenCalledTimes(1)
    f.data('\x1b]133;D;0\x07\x1b]133;C\x07\x1b]133;D;0\x07')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(f.capture).toHaveBeenCalledTimes(1)
  })

  it('does not read when an identified owner appears before the scheduled observation', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.data('\x1b]133;C\x07')
    f.setRows([
      {
        paneKey,
        tabId: 'tab',
        worktreeId: 'folder',
        connectionId: null,
        state: 'done',
        prompt: '',
        receivedAt: 1,
        stateStartedAt: 1,
        agentPresence: owner,
        providerSessionOnly: true
      }
    ])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.capture).not.toHaveBeenCalled()
  })

  it.each(['command end', 'controller replacement', 'terminal release'])(
    'discards pending capture after %s',
    async (reason) => {
      vi.useFakeTimers()
      const f = fixture()
      let finish!: (presence: AgentProcessPresence) => void
      f.capture.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      f.data('\x1b]133;C\x07')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(f.capture).toHaveBeenCalledTimes(1)
      if (reason === 'command end') {
        f.data('\x1b]133;D;0\x07')
      } else if (reason === 'controller replacement') {
        f.runtime.setPtyController({ ...f.controller })
      } else {
        f.runtime.onPtyExit('pty', 0)
      }
      finish(owner)
      await vi.advanceTimersByTimeAsync(1)
      expect(f.publish).not.toHaveBeenCalled()
    }
  )

  it('keeps WSL and remote discovery on their execution-host boundary', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.runtime.registerPty('wsl', 'folder', null, { tabId: 'wsl', leafId }, true)
    f.runtime.registerPty('ssh', 'folder', 'connection', { tabId: 'ssh', leafId })
    for (const id of ['wsl', 'ssh']) {
      f.runtime.onPtyData(id, '\x1b]133;C\x07', Date.now())
    }
    await vi.advanceTimersByTimeAsync(2_000)
    expect(f.capture).not.toHaveBeenCalled()
  })
})
