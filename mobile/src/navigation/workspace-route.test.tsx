import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement, type ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

const route = vi.hoisted(() => {
  const state: {
    params: Record<string, string>
    hostCapabilities: string[]
    statusPending: boolean
    seen: (string | undefined)[]
    shellRoutes: { params?: Record<string, string> }[]
    redirects: { params: Record<string, string | undefined> }[]
  } = {
    params: {},
    hostCapabilities: [],
    statusPending: false,
    seen: [],
    shellRoutes: [],
    redirects: []
  }
  return state
})

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => route.params,
  useRouter: () => ({ setParams: () => {}, replace: () => {} }),
  Redirect: ({ href }: { href: { params: Record<string, string | undefined> } }) => {
    route.redirects.push(href)
    return null
  }
}))
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable'
}))
vi.mock('../transport/client-context', () => ({
  useHostClient: () => ({ client: {}, state: 'connected' })
}))
vi.mock('../components/host-protocol-gates-context', () => ({
  useOptionalHostProtocolGates: () => ({
    hostCapabilities: route.hostCapabilities,
    statusPending: route.statusPending
  })
}))
vi.mock('./route-handoff', () => ({ useRouteHandoff: () => ({ replace: () => {} }) }))
// The native switch always hands the page its route, so the census reads what the page is told.
vi.mock('../mobile-web-shell/shell-switch-decision', () => ({
  useShellSwitchDecision: (shellRoute: unknown) =>
    shellRoute ? { kind: 'shell', route: shellRoute } : { kind: 'native' }
}))
vi.mock('../mobile-web-shell/ShellSwitchPendingScreen', () => ({
  ShellSwitchPendingScreen: () => null
}))
vi.mock('../mobile-web-shell/MobileWebShellScreen', () => ({
  MobileWebShellScreen: ({ route: shellRoute }: { route: { params?: Record<string, string> } }) => {
    route.shellRoutes.push(shellRoute)
    return createElement(Probe)
  }
}))
// Each workspace screen stands in as a probe reporting the server its subtree names.
vi.mock('../files/MobileFileExplorerPanel', () => ({ MobileFileExplorerPanel: Probe }))
vi.mock('../files/MobileFilePreviewScreen', () => ({ MobileFilePreviewScreen: Probe }))
vi.mock('../source-control/MobileSourceControlPanel', () => ({ MobileSourceControlPanel: Probe }))
vi.mock('../session/MobileDiffReviewRouteScreen', () => ({ MobileDiffReviewRouteScreen: Probe }))
vi.mock('../session/MobileSessionRouteScreen', () => ({ MobileSessionRouteScreen: Probe }))
vi.mock('../agent-history/MobileAgentSessionHistoryPanel', () => ({
  MobileAgentSessionHistoryPanel: Probe
}))

import { MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY } from '../../../src/shared/mobile-desktop-relay-contract'
import { useWorkspaceExecutionHost } from './workspace-execution-host'
import { WorkspaceRoute } from './workspace-route'

function Probe(): null {
  route.seen.push(useWorkspaceExecutionHost())
  return null
}

const HOST_ROUTES = fileURLToPath(new URL('../../app/h/[hostId]/', import.meta.url))
// Every screen keyed by a workspace, native and page, found on disk so a new one is counted.
const WORKSPACE_ROUTE_FILES = readdirSync(HOST_ROUTES, { recursive: true, encoding: 'utf8' })
  .map((entry) => entry.replaceAll('\\', '/'))
  .filter((entry) => /(^|\/)\[worktreeId\](\.web)?\.tsx$/.test(entry))
  .sort()

async function render(element: ReactElement): Promise<ReactTestRenderer> {
  route.seen.length = 0
  route.shellRoutes.length = 0
  route.redirects.length = 0
  let renderer: ReactTestRenderer | null = null
  await act(async () => {
    renderer = create(element)
  })
  if (!renderer) {
    throw new Error('did not render')
  }
  return renderer
}

function texts(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll(() => true)
    .flatMap((node) => node.children.filter((child) => typeof child === 'string'))
}

describe('every workspace route', () => {
  it('is found on disk', () => {
    expect(WORKSPACE_ROUTE_FILES.length).toBeGreaterThanOrEqual(14)
  })

  it.each(WORKSPACE_ROUTE_FILES)('keeps %s on the server its route names', async (file) => {
    route.params = {
      hostId: 'host-1',
      worktreeId: 'wt-1',
      relativePath: 'README.md',
      // Spelled loosely, so a screen reading the raw param instead of its route is caught.
      executionHost: ' runtime:vm '
    }
    route.hostCapabilities = [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY]
    route.statusPending = false
    const Screen = (await import(/* @vite-ignore */ `${HOST_ROUTES}${file}`)).default
    await render(createElement(Screen))
    if (route.redirects.length > 0) {
      expect(route.redirects.map((href) => href.params.executionHost?.trim())).toEqual([
        'runtime:vm'
      ])
      return
    }
    expect(route.seen).toEqual(['runtime:vm'])
    for (const shellRoute of route.shellRoutes) {
      expect(shellRoute.params?.executionHost).toBe('runtime:vm')
    }
  })
})

describe('a server workspace the phone cannot reach', () => {
  const child = createElement(Probe)

  it('says so once the desktop has answered, instead of waiting forever', async () => {
    route.params = { hostId: 'host-1', executionHost: 'runtime:vm' }
    route.hostCapabilities = []
    route.statusPending = false
    const renderer = await render(createElement(WorkspaceRoute, null, child))
    expect(route.seen).toEqual([])
    expect(texts(renderer)).toContain(
      "Your phone can't reach this workspace's server through this desktop."
    )
  })

  it('waits while the desktop has not answered, and opens a reachable one', async () => {
    route.params = { hostId: 'host-1', executionHost: 'runtime:vm' }
    route.hostCapabilities = []
    route.statusPending = true
    await render(createElement(WorkspaceRoute, null, child))
    expect(route.seen).toEqual(['runtime:vm'])
    route.hostCapabilities = [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY]
    route.statusPending = false
    await render(createElement(WorkspaceRoute, null, child))
    expect(route.seen).toEqual(['runtime:vm'])
  })

  it('never stands in for the desktop’s own workspaces', async () => {
    route.params = { hostId: 'host-1' }
    route.hostCapabilities = []
    route.statusPending = false
    await render(createElement(WorkspaceRoute, null, child))
    expect(route.seen).toEqual([undefined])
  })
})
