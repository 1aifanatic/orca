// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { resetBrowserClientHostIdForTests } from '@/runtime/browser-client-host-identity'
import { installClientHostedPaneApi } from './client-hosted-browser-pane-test-rig'
import { ClientHostedBrowserAvailabilityNotice } from './client-hosted-browser-unavailable-notice'

const resumeBrowserClientHost = vi.fn(async () => {})

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

function setHostOffline(offline: boolean): void {
  useAppStore.setState({
    runtimeStatusByEnvironmentId: offline ? new Map([['env-a', { status: null }]]) : new Map(),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the notice reads only id and name.
    runtimeEnvironments: [{ id: 'env-a', name: 'Build box' }] as never
  })
}

describe('ClientHostedBrowserAvailabilityNotice', () => {
  beforeEach(() => {
    resetBrowserClientHostIdForTests()
    resumeBrowserClientHost.mockClear()
    installClientHostedPaneApi({
      browser: { readClientHostId: () => 'this-desktop' },
      runtimeEnvironments: { resumeBrowserClientHost }
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

  it('marks a live page whose host is offline, and a click asks for a re-attach', () => {
    setHostOffline(true)
    renderNotice()

    expect(screen.getByRole('status').textContent).toContain('Build box is offline')
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect now' }))
    expect(resumeBrowserClientHost).toHaveBeenCalledWith('env-a')
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

  it('asks a parked host to re-attach when the tab is opened', () => {
    renderNotice({ isActive: true })

    expect(resumeBrowserClientHost).toHaveBeenCalledWith('env-a')
  })
})
