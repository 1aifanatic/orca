// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const run = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../lib/agent-launch-follow-up-waiter', () => ({ runRecordedLaunchFollowUps: run }))

const { useAppStore } = await import('../store')
const { useRecordedLaunchFollowUps } = await import('./use-recorded-launch-follow-ups')

beforeEach(() => {
  run.mockClear()
  useAppStore.setState({ workspaceSessionReady: false })
})

describe('a window starting up takes what its launches recorded for it', () => {
  it('once its worktrees and notes are loaded, and only once', () => {
    const { rerender } = renderHook(() => useRecordedLaunchFollowUps())
    expect(run).not.toHaveBeenCalled()
    act(() => useAppStore.setState({ workspaceSessionReady: true }))
    expect(run).toHaveBeenCalledOnce()
    rerender()
    expect(run).toHaveBeenCalledOnce()
  })
})
