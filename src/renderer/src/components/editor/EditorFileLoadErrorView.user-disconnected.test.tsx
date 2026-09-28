// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { resetSshConnectInFlightForTests } from '@/ssh/ssh-connect-in-flight'
import type { WorktreeHostConnection } from '@/lib/worktree-host-connection-phase'

const mocks = vi.hoisted(() => {
  const hostConnection: WorktreeHostConnection = {
    phase: 'unavailable',
    targetId: 'ssh-a',
    environmentId: null,
    publishedStatus: 'disconnected',
    connectedEpoch: null,
    unavailableReason: 'user-disconnected'
  }
  return { connect: vi.fn(), ensureConnected: vi.fn(), hostConnection }
})

vi.mock('@/lib/worktree-host-connection-phase', () => ({
  useWorktreeHostConnection: () => mocks.hostConnection
}))

import { EditorFileLoadErrorView } from './EditorFileLoadErrorView'

describe("EditorFileLoadErrorView on a host the user's Disconnect holds down", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    useAppStore.setState({ sshTargetLabels: new Map([['ssh-a', 'devbox']]) })
    resetSshConnectInFlightForTests()
    mocks.connect.mockReset().mockResolvedValue(null)
    mocks.ensureConnected.mockReset()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ssh: { connect: mocks.connect, ensureConnected: mocks.ensureConnected } }
    })
  })
  afterEach(cleanup)

  it("offers the user's own Connect in place of Retry", async () => {
    const onRetry = vi.fn()
    const { container } = render(
      <EditorFileLoadErrorView message="read failed" worktreeId="wt-ssh" onRetry={onRetry} />
    )

    screen.getByText('You disconnected devbox')
    screen.getByText('Connect it to load this file.')
    // Why: the user's own Disconnect is not a load failure, so the card must not read as one.
    expect(screen.queryByText('Unable to load file')).toBeNull()
    expect(container.querySelector('.text-destructive')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    })

    expect(mocks.connect).toHaveBeenCalledWith({ targetId: 'ssh-a' })
    expect(mocks.ensureConnected).not.toHaveBeenCalled()
    expect(onRetry).not.toHaveBeenCalled()
  })
})
