import './mock-descendant-sweep'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const { mockPtySpawn, mockPtyInstance, mockCreateShellPromptReadinessProbe } = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtyInstance: {
    pid: process.pid,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}))

vi.mock('node-pty', () => ({
  spawn: mockPtySpawn
}))

vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))

vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mockCreateShellPromptReadinessProbe
}))

import type { PtyHandler } from './pty-handler'
import { beginPtyHandlerTest, endPtyHandlerTest } from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'

// The blocking hook POST used to put an agent's event on the wire before the agent could print or
// exit. With committed hooks, the relay drains through this barrier to keep that order.
describe('PtyHandler output publish barrier', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined

  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
  })

  it('runs before the output and the exit it precedes reach the client', async () => {
    let onData: ((data: string) => void) | undefined
    let onExit: ((evt: { exitCode: number }) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn((cb: (data: string) => void) => {
        onData = cb
      }),
      onExit: vi.fn((cb: (evt: { exitCode: number }) => void) => {
        onExit = cb
      })
    })
    const wire: string[] = []
    handler.setOutputPublishBarrier(() => wire.push('barrier'))
    dispatcher.notify.mockImplementation((method: string) => {
      if (method === 'pty.data' || method === 'pty.exit') {
        wire.push(method)
      }
    })
    await dispatcher.callRequest('pty.spawn', {})

    onData!('title reverted to the shell')
    vi.advanceTimersByTime(8)
    onData!('bye')
    onExit!({ exitCode: 0 })

    expect(wire).toEqual(['barrier', 'pty.data', 'barrier', 'pty.data', 'pty.exit'])
  })
})
