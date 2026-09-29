import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SourceControlPanelReadyProps } from './panel-props'

vi.stubGlobal('window', { setTimeout: () => 0 })
vi.mock('./dialog-layer', () => ({ SourceControlDialogLayer: () => null }))

import { SourceControlPanelDialogs } from './panel-dialogs'

type DialogLayerProps = {
  onSelectBaseRef: (ref: string) => void
  onUsePrimaryBaseRef?: () => void
}

const updateRepo = vi.fn(async () => undefined)
const updateWorktreeMeta = vi.fn(async () => ({ ok: true }))

function renderDialogLayerProps(opts: {
  activeWorktreeId: string | null
  baseRefOwnedByWorktree: boolean
}): DialogLayerProps {
  const model = {
    activeWorktreeId: opts.activeWorktreeId,
    baseRefOwnedByWorktree: opts.baseRefOwnedByWorktree,
    setBaseRefDialogOpen: () => {},
    refreshBranchCompare: async () => {},
    updateRepo,
    updateWorktreeMeta,
    getLaunchActionRecipe: () => ({})
  }
  const props = {
    activeRepo: { id: 'r1' },
    activeWorktree: { id: 'r1::/a', repoId: 'r1' },
    model
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the component reads only the fields stubbed above.
  const element = SourceControlPanelDialogs(props as unknown as SourceControlPanelReadyProps)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SourceControlDialogLayer is mocked, so props are the raw callbacks.
  return element.props as DialogLayerProps
}

describe('SourceControlPanelDialogs base ref', () => {
  beforeEach(() => {
    updateRepo.mockClear()
    updateWorktreeMeta.mockClear()
  })

  it('pins the active worktree, not the repo, when the worktree has no own base ref', () => {
    const props = renderDialogLayerProps({
      activeWorktreeId: 'r1::/a',
      baseRefOwnedByWorktree: false
    })
    props.onSelectBaseRef('origin/release-2')
    expect(updateRepo).not.toHaveBeenCalled()
    expect(updateWorktreeMeta).toHaveBeenCalledWith('r1::/a', { baseRef: 'origin/release-2' })
  })

  it('"use primary" clears only the worktree override', () => {
    const props = renderDialogLayerProps({
      activeWorktreeId: 'r1::/a',
      baseRefOwnedByWorktree: true
    })
    props.onUsePrimaryBaseRef?.()
    expect(updateRepo).not.toHaveBeenCalled()
    expect(updateWorktreeMeta).toHaveBeenCalledWith('r1::/a', { baseRef: undefined })
  })

  it('hides "use primary" when the worktree has no override to clear', () => {
    const props = renderDialogLayerProps({
      activeWorktreeId: 'r1::/a',
      baseRefOwnedByWorktree: false
    })
    expect(props.onUsePrimaryBaseRef).toBeUndefined()
  })
})
