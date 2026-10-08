// @vitest-environment happy-dom

import { act, isValidElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { showDeleteWorktreeFailureToast } from './delete-worktree-failure-toast'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }))

let root: Root | undefined

function renderRecovery(onAlwaysForceDelete: () => Promise<void>, canForceDelete = true) {
  const onForceDelete = vi.fn()
  showDeleteWorktreeFailureToast({
    error: 'branch has changes',
    canForceDelete,
    forceDeleteReason: canForceDelete ? 'dirty' : null,
    onViewChanges: vi.fn(),
    onForceDelete,
    onAlwaysForceDelete,
    onDeleteAnyway: vi.fn(),
    worktreeId: 'wt-1',
    worktreeName: 'feature/foo'
  })
  const description = vi
    .mocked(canForceDelete ? toast.info : toast.error)
    .mock.calls.at(-1)?.[1]?.description
  if (!isValidElement(description)) {
    throw new Error('Expected a rendered recovery toast')
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root?.render(description))
  return { container, onForceDelete }
}

function click(container: HTMLElement, selector: string): void {
  const element = container.querySelector(selector)
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing ${selector}`)
  }
  element.click()
}

afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

it('keeps Force Delete a one-time action unless the checkbox is selected', async () => {
  const savePreference = vi.fn().mockResolvedValue(undefined)
  const { container, onForceDelete } = renderRecovery(savePreference)
  expect(container.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('false')

  await act(async () => click(container, 'button[data-variant="destructive"]'))

  expect(savePreference).not.toHaveBeenCalled()
  expect(onForceDelete).toHaveBeenCalledOnce()
})

it('waits for the preference to persist before force-deleting and dismissing', async () => {
  let finishSaving: (() => void) | undefined
  const savePreference = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishSaving = resolve
      })
  )
  const { container, onForceDelete } = renderRecovery(savePreference)
  await act(async () => click(container, '[role="checkbox"]'))
  expect(savePreference).not.toHaveBeenCalled()
  await act(async () => click(container, 'button[data-variant="destructive"]'))

  expect(savePreference).toHaveBeenCalledOnce()
  expect(
    container.querySelector('button[data-variant="destructive"]')?.hasAttribute('disabled')
  ).toBe(true)
  expect(onForceDelete).not.toHaveBeenCalled()
  expect(toast.dismiss).not.toHaveBeenCalled()
  await act(async () => finishSaving?.())
  expect(onForceDelete).toHaveBeenCalledOnce()
  expect(toast.dismiss).toHaveBeenCalledWith('delete-worktree-failure:wt-1')
})

it('keeps recovery available when saving the preference fails', async () => {
  const { container, onForceDelete } = renderRecovery(
    vi.fn().mockRejectedValue(new Error('Disk full'))
  )
  await act(async () => click(container, '[role="checkbox"]'))
  await act(async () => click(container, 'button[data-variant="destructive"]'))

  expect(onForceDelete).not.toHaveBeenCalled()
  expect(toast.dismiss).not.toHaveBeenCalled()
  expect(toast.error).toHaveBeenCalledWith('Could not save deletion preference', {
    description: 'Disk full'
  })
  expect(
    container.querySelector('button[data-variant="destructive"]')?.hasAttribute('disabled')
  ).toBe(false)
})

it('does not offer the preference for a failure that cannot be force-deleted', () => {
  const { container } = renderRecovery(vi.fn(), false)
  expect(container.querySelector('[role="checkbox"]')).toBeNull()
})
