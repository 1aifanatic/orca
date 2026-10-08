import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

vi.mock('expo-router', () => ({ useFocusEffect: () => {} }))
vi.mock('react-native', () => ({}))
vi.mock('../transport/host-removal-lifecycle', () => ({ removeHostAndCloseClient: async () => {} }))
vi.mock('../host-route-exit', () => ({ leaveHostRoute: () => {} }))
vi.mock('../cache/worktree-cache', () => ({
  getCachedWorktrees: () => null,
  setCachedWorktrees: () => {}
}))
vi.mock('../storage/preferences', () => ({ savePinnedIds: async () => {} }))
vi.mock('../worktree/host-worktree-refresh', () => ({ startHostWorktreeRefresh: () => () => {} }))
vi.mock('../transport/use-worktree-resync', () => ({
  useWorktreeResync: () => ({ refreshing: false, onRefresh: async () => {} })
}))

import { MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY } from '../../../src/shared/mobile-desktop-relay-contract'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { RpcResponse } from '../transport/types'
import { readVisibleHostIds } from '../worktree/visible-host-rows'
import type { Worktree } from '../worktree/workspace-list-types'
import { useHostDisplayWorktrees } from './use-host-display-worktrees'
import { useHostScreenState } from './use-host-screen-state'
import { useHostWorktreeActions } from './use-host-worktree-actions'
import { useHostWorktreeCatalog } from './use-host-worktree-catalog'

const RELAYS = [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY]

function reply(result: unknown): RpcResponse {
  return { id: 'reply', ok: true, result, _meta: { runtimeId: 'runtime' } }
}

function row(worktreeId: string, hostId?: string): Record<string, unknown> {
  return {
    worktreeId,
    repoId: `repo-${worktreeId}`,
    hostId,
    repo: worktreeId,
    branch: 'main',
    displayName: worktreeId,
    path: `/w/${worktreeId}`,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    preview: '',
    unread: false,
    isPinned: false,
    linkedPR: null
  }
}

const HOSTS = [
  { hostId: 'runtime:vm', label: 'VM', health: 'available', relay: 'ready' },
  { hostId: 'runtime:old', label: 'ThinkPad', health: 'available', relay: 'update-needed' }
]

type Desktop = {
  hostWorktrees?: (hostId: string) => unknown
  carriesExecutionHost?: boolean
}

function desktop({ hostWorktrees, carriesExecutionHost }: Desktop = {}): FakeSession {
  const client = new FakeSession('connected')
  if (carriesExecutionHost !== undefined) {
    Object.assign(client, { carriesExecutionHost: () => carriesExecutionHost })
  }
  client.sendRequest.mockImplementation(async (method: string, params?: unknown) => {
    switch (method) {
      case 'worktree.ps':
        return reply({ worktrees: [row('mac-wt', 'local')], snapshotId: 's1' })
      case 'mobileRelay.hosts.list':
        return reply({ hosts: HOSTS })
      case 'mobileRelay.hosts.worktrees': {
        const { hostId } = z.object({ hostId: z.string() }).parse(params)
        const result = hostWorktrees
          ? hostWorktrees(hostId)
          : { worktrees: [row(`${hostId}-wt`, hostId)], stale: false, fetchedAt: 1 }
        if (result instanceof Error) {
          throw result
        }
        return reply(result)
      }
      default:
        return reply({})
    }
  })
  return client
}

type Screen = {
  rows: () => Worktree[]
  poll: () => Promise<void>
  hideHosts: (ids: string[]) => void
  open: (worktreeId: string) => void
  notice: () => string | null
  catalogError: () => string | null
  navigations: string[]
}

async function mountScreen(client: FakeSession, hostCapabilities: string[]): Promise<Screen> {
  const navigations: string[] = []
  const router = { push: (to: string) => navigations.push(to), replace: () => {} }
  const held: {
    rows: Worktree[]
    state?: ReturnType<typeof useHostScreenState>
    fetch?: () => Promise<void>
    actions?: ReturnType<typeof useHostWorktreeActions>
  } = { rows: [] }
  function Probe(): null {
    const state = useHostScreenState('host-1', undefined)
    state.clientRef.current = client
    const catalog = useHostWorktreeCatalog({
      client,
      connState: 'connected',
      embedded: true,
      fetchRepoMetadata: async () => {},
      hostCapabilities,
      hostId: 'host-1',
      state,
      syncViewSettingsFromDesktop: async () => {}
    })
    held.actions = useHostWorktreeActions({
      client,
      connState: 'connected',
      embedded: false,
      fetchWorktrees: catalog.fetchWorktrees,
      forgetHostClient: () => {},
      hostCapabilities,
      hostId: 'host-1',
      pathname: '/h/host-1',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the actions only push and replace.
      router: router as unknown as Parameters<typeof useHostWorktreeActions>[0]['router'],
      state
    })
    held.state = state
    held.fetch = catalog.fetchWorktrees
    held.rows = useHostDisplayWorktrees('connected', state)
    return null
  }
  await act(async () => {
    create(createElement(Probe))
  })
  const poll = async (): Promise<void> => {
    await act(async () => {
      await held.fetch?.()
      await vi.waitFor(() => expect(held.state?.fetchWorktreesInFlightRef.current).toBe(false))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  await poll()
  return {
    rows: () => held.rows,
    poll,
    hideHosts: (ids) => act(() => held.state?.setVisibleHostIds(readVisibleHostIds(ids))),
    open: (worktreeId) =>
      act(() => {
        const item = held.rows.find((entry) => entry.worktreeId === worktreeId)
        held.actions?.openWorktreeSession(item!)
      }),
    notice: () => held.state?.serverNotice ?? null,
    catalogError: () => held.state?.catalogError ?? null,
    navigations
  }
}

function listed(rows: Worktree[]): [string, string | undefined, string | undefined][] {
  return rows.map((entry) => [entry.worktreeId, entry.hostId, entry.hostContextHealthLabel])
}

function calledMethods(client: FakeSession): string[] {
  return client.sendRequest.mock.calls.map(([method]) => method)
}

describe("a desktop's server workspaces on the phone", () => {
  it('lists each server through the desktop, badged with its own health', async () => {
    const screen = await mountScreen(desktop(), RELAYS)
    expect(listed(screen.rows())).toEqual([
      ['mac-wt', 'local', undefined],
      ['runtime:vm-wt', 'runtime:vm', undefined],
      ['runtime:old-wt', 'runtime:old', 'Update needed']
    ])
    expect(screen.rows().map((entry) => entry.hostContextLabel)).toEqual([
      expect.any(String),
      'VM',
      'ThinkPad'
    ])
  })

  it('keeps showing today’s view under an older desktop or an older shell', async () => {
    const oldDesktop = desktop()
    const oldShell = desktop({ carriesExecutionHost: false })
    for (const [client, capabilities] of [
      [oldDesktop, []],
      [oldShell, RELAYS]
    ] as const) {
      const screen = await mountScreen(client, [...capabilities])
      expect(listed(screen.rows())).toEqual([['mac-wt', 'local', undefined]])
      expect(calledMethods(client).filter((method) => method.startsWith('mobileRelay.'))).toEqual(
        []
      )
    }
  })

  it('shows no server rows, and no error, when the desktop cannot answer the hosts list', async () => {
    const client = desktop()
    const base = client.sendRequest.getMockImplementation()!
    client.sendRequest.mockImplementation(async (method: string, params?: unknown) =>
      method.startsWith('mobileRelay.')
        ? {
            id: 'reply',
            ok: false,
            error: { code: 'method_not_found', message: `Unknown method: ${method}` },
            _meta: { runtimeId: 'runtime' }
          }
        : base(method, params)
    )
    const screen = await mountScreen(client, RELAYS)
    expect(listed(screen.rows())).toEqual([['mac-wt', 'local', undefined]])
    expect(calledMethods(client)).toContain('mobileRelay.hosts.list')
    expect(screen.catalogError()).toBeNull()
  })

  it('keeps a server’s rows when one poll cannot read them, and drops a server the desktop forgot', async () => {
    let failing = false
    const client = desktop({
      hostWorktrees: (hostId) =>
        failing && hostId === 'runtime:vm'
          ? new Error('timed out')
          : { worktrees: [row(`${hostId}-wt`, hostId)], stale: false, fetchedAt: 1 }
    })
    const screen = await mountScreen(client, RELAYS)
    failing = true
    await screen.poll()
    expect(screen.rows().map((entry) => entry.worktreeId)).toContain('runtime:vm-wt')
    // A row naming another host is refused rather than listed under this one.
    client.sendRequest.mockImplementation(async (method: string) =>
      method === 'mobileRelay.hosts.list'
        ? reply({ hosts: [HOSTS[1]] })
        : method === 'mobileRelay.hosts.worktrees'
          ? reply({ worktrees: [row('stray', 'runtime:vm')], stale: true, fetchedAt: 1 })
          : reply({ worktrees: [row('mac-wt', 'local')], snapshotId: 's1' })
    )
    await screen.poll()
    expect(screen.rows().map((entry) => entry.worktreeId)).toEqual(['mac-wt'])
  })

  it('follows the desktop’s hidden hosts, across its own and its servers’ rows', async () => {
    const screen = await mountScreen(desktop(), RELAYS)
    screen.hideHosts(['local', 'runtime:old'])
    expect(screen.rows().map((entry) => entry.worktreeId)).toEqual(['mac-wt', 'runtime:old-wt'])
    // One shown host is the desktop's single-host focus, which the phone does not follow.
    screen.hideHosts(['runtime:old'])
    expect(screen.rows()).toHaveLength(3)
  })

  it('opens a ready server workspace there, and explains one that needs an update', async () => {
    const client = desktop()
    const screen = await mountScreen(client, RELAYS)
    screen.open('runtime:vm-wt')
    expect(screen.navigations).toEqual([
      '/h/host-1/session/runtime%3Avm-wt?name=runtime%3Avm-wt&executionHost=runtime%3Avm'
    ])
    await vi.waitFor(() =>
      expect(client.sendRequest).toHaveBeenCalledWith(
        'worktree.activate',
        expect.objectContaining({ worktree: 'id:runtime:vm-wt' }),
        { executionHost: 'runtime:vm' }
      )
    )
    screen.open('runtime:old-wt')
    expect(screen.navigations).toHaveLength(1)
    expect(screen.notice()).toBe('Update Orca on ThinkPad to open its workspaces from your phone.')
  })
})
