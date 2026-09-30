// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state = {
    modalData: {
      worktreeId: 'repo-1::/workspace/feature-wt',
      displayName: 'feature-wt',
      resolution: { kind: 'not-ssh' },
      executionHostId: 'local'
    },
    closeModal: vi.fn(),
    removeWorktree: vi.fn(async () => ({ ok: true })),
    sshTargetLabels: new Map<string, string>(),
    removedSshTargetLabels: new Map<string, string>()
  }
  return { state }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state }
  )
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, vars?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => vars?.[name] ?? '')
}))
vi.mock('./delete-worktree-flow', () => ({ runWorktreeDeleteWithToast: vi.fn() }))

import { ForgetSshWorkspaceDialog } from './ForgetSshWorkspaceDialog'

describe('ForgetSshWorkspaceDialog for a local row whose delete failed', () => {
  afterEach(() => {
    cleanup()
  })

  it('offers only Remove from Orca, which forgets the row on its own host', async () => {
    render(<ForgetSshWorkspaceDialog />)

    expect(screen.getByText('Remove “feature-wt” from Orca?')).toBeTruthy()
    expect(
      screen.getByText(
        'Removes this workspace from Orca only. Its remaining files and its branch stay on disk.'
      )
    ).toBeTruthy()
    expect(screen.queryByText('Reconnect & Delete')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Remove from Orca' }))

    await waitFor(() => expect(mocks.state.closeModal).toHaveBeenCalled())
    expect(mocks.state.removeWorktree).toHaveBeenCalledWith(
      { id: 'repo-1::/workspace/feature-wt', executionHostId: 'local' },
      false,
      { mode: 'forget-local' }
    )
  })
})
