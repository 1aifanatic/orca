import './mock-descendant-sweep'
import { rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonServer } from './daemon-server'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'

describe('DaemonPtyAdapter startup-command marks', () => {
  let dir: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter

  beforeEach(async () => {
    const harness = await startDaemonAdapterHarness(() => createMockSubprocess())
    dir = harness.dir
    server = harness.server
    adapter = harness.adapter
  })

  afterEach(async () => {
    adapter?.dispose()
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  it.each([
    ['zsh', true],
    ['bash', true],
    ['fish', false],
    ['ksh', false]
  ])(
    'reports whether the %s wrapper the daemon launches marks the startup command',
    async (shell, marked) => {
      const result = await adapter.spawn({
        cols: 80,
        rows: 24,
        command: 'goose',
        env: { SHELL: shell }
      })

      expect(result.startupCommandMarked).toBe(marked)
    }
  )

  it('says nothing for a pane without a startup command', async () => {
    const result = await adapter.spawn({ cols: 80, rows: 24, env: { SHELL: 'zsh' } })

    expect(result.startupCommandMarked).toBeUndefined()
  })
})
