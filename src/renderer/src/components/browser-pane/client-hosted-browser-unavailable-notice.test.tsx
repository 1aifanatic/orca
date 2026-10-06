// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { resetBrowserClientHostIdForTests } from '@/runtime/browser-client-host-identity'
import { resetRestoredBrowserClientHostAttachForTests } from '@/runtime/restored-client-hosted-browser-host-attach'
import { installClientHostedPaneApi } from './client-hosted-browser-pane-test-rig'
import { ClientHostedBrowserAvailabilityNotice } from './client-hosted-browser-unavailable-notice'

const retryControlConnection = vi.fn(async () => {})
const prepareBrowserClientHostPlacement = vi.fn(async () => ({ kind: 'client' }))

function renderNotice(
  props: Partial<Parameters<typeof ClientHostedBrowserAvailabilityNotice>[0]> = {}
) {
  return render(
    <ClientHostedBrowserAvailabilityNotice
      runtimeEnvironmentId="env-a"
      worktreeId="worktree-a"
      lastCommittedUrl="https://example.internal/"
      guestUnavailable={false}
      browserHostClientId="this-desktop"
      isActive={false}
      {...props}
    />
  )
}

const clientHostedPage = { environmentId: 'env-a', placement: { kind: 'client' } }
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the attach reads only environmentId and placement.
const CLIENT_HOSTED_PAGE_HANDLES = { 'page-a': clientHostedPage } as never

function setHostOffline(offline: boolean): void {
  useAppStore.setState({
    runtimeStatusByEnvironmentId: offline ? new Map([['env-a', { status: null }]]) : new Map(),
    remoteBrowserPageHandlesByPageId: CLIENT_HOSTED_PAGE_HANDLES,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the notice reads only id and name.
    runtimeEnvironments: [{ id: 'env-a', name: 'Build box' }] as never
  })
}

describe('ClientHostedBrowserAvailabilityNotice', () => {
  beforeEach(() => {
    resetBrowserClientHostIdForTests()
    resetRestoredBrowserClientHostAttachForTests()
    retryControlConnection.mockClear()
    prepareBrowserClientHostPlacement.mockClear()
    installClientHostedPaneApi({
      browser: { readClientHostId: () => 'this-desktop' },
      runtimeEnvironments: { retryControlConnection, prepareBrowserClientHostPlacement }
    })
  })
  afterEach(() => {
    cleanup()
    setHostOffline(false)
  })

  it('stays out of the way of a live page whose host is reachable or not yet checked', () => {
    setHostOffline(false)
    const { container } = renderNotice()

    expect(container.innerHTML).toBe('')
  })

  it('marks a live page whose host is offline, and a click retries that host and its browser host', () => {
    setHostOffline(true)
    renderNotice()

    expect(screen.getByRole('status').textContent).toContain('Build box is offline')
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect now' }))
    expect(retryControlConnection).toHaveBeenCalledWith({ selector: 'env-a' })
    expect(prepareBrowserClientHostPlacement).toHaveBeenCalledWith({
      selector: 'env-a',
      preference: 'auto'
    })
  })

  it('waits for an offline host instead of calling a missing guest unavailable', () => {
    setHostOffline(true)
    renderNotice({ guestUnavailable: true })

    expect(screen.getByText('Build box is offline')).toBeTruthy()
    expect(screen.queryByText('Client-hosted browser unavailable')).toBeNull()
  })

  it('names another desktop only when the placement actually names one', () => {
    renderNotice({ guestUnavailable: true, browserHostClientId: 'other-desktop' })
    expect(screen.getByText('This page is open on a different desktop.')).toBeTruthy()
    cleanup()

    renderNotice({ guestUnavailable: true, browserHostClientId: 'this-desktop' })
    expect(screen.getByText('This page is no longer available on this desktop.')).toBeTruthy()
    expect(screen.queryByText(/different desktop/)).toBeNull()
  })

  it('asks only its own environment to re-attach when the tab is opened', () => {
    setHostOffline(false)
    renderNotice({ isActive: true })

    expect(prepareBrowserClientHostPlacement).toHaveBeenCalledWith({
      selector: 'env-a',
      preference: 'auto'
    })
    expect(retryControlConnection).not.toHaveBeenCalled()
  })
})
