import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installIpcPtyWindow, restorePtySpecWindow } from './pty-transport-test-harness'
import { describeLaunchFileUnavailable } from '../../../../shared/launch-prompt-file'

const mocks = vi.hoisted(() => ({ showNotStarted: vi.fn() }))
vi.mock('@/lib/agent-launch-prompt-not-delivered-notice', () => ({
  showAgentLaunchNotStartedNotice: mocks.showNotStarted
}))

describe('a pane spawn the host refused for what carries its prompt', () => {
  const originalWindow = globalThis.window

  beforeEach(() => {
    vi.resetModules()
    mocks.showNotStarted.mockReset()
    installIpcPtyWindow(originalWindow, { data: () => {}, exit: () => {} })
  })

  afterEach(() => {
    restorePtySpecWindow(originalWindow)
  })

  // Why: a WSL launch with no launch file still needs its staged line written into the distro.
  it('hands back a staged line’s prompt to copy, as it does a launch file’s', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    vi.mocked(window.api.pty.spawn).mockRejectedValueOnce(
      new Error(describeLaunchFileUnavailable('unreachable', 'staged-line'))
    )

    await createIpcPtyTransport({
      command: "claude 'a long prompt'",
      launchPrompt: 'a long prompt'
    }).connect({ url: '', callbacks: { onError: vi.fn() } })

    expect(mocks.showNotStarted).toHaveBeenCalledWith({ prompt: 'a long prompt' })
  })

  it('stays quiet for any other spawn failure', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    vi.mocked(window.api.pty.spawn).mockRejectedValueOnce(new Error('spawn ENOENT'))

    await createIpcPtyTransport({ command: 'claude', launchPrompt: 'fix it' }).connect({
      url: '',
      callbacks: { onError: vi.fn() }
    })

    expect(mocks.showNotStarted).not.toHaveBeenCalled()
  })
})
