import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

const seen = vi.hoisted(() => {
  const hosts: (string | undefined)[] = []
  return hosts
})

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({
    hostId: 'host-1',
    worktreeId: 'wt-1',
    relativePath: 'README.md',
    executionHost: 'runtime:vm'
  })
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

import { useWorkspaceExecutionHost } from './workspace-execution-host'

function Probe(): null {
  seen.push(useWorkspaceExecutionHost())
  return null
}

const SCREENS = {
  files: () => import('../../app/h/[hostId]/files/[worktreeId].web'),
  'file preview': () => import('../../app/h/[hostId]/files/preview/[worktreeId].web'),
  'source control': () => import('../../app/h/[hostId]/source-control/[worktreeId].web'),
  review: () => import('../../app/h/[hostId]/review/[worktreeId].web'),
  session: () => import('../../app/h/[hostId]/session/[worktreeId].web'),
  'agent history': () => import('../../app/h/[hostId]/agent-history/[worktreeId].web')
}

describe('a workspace route', () => {
  it.each(Object.entries(SCREENS))(
    'names its server to everything under the %s screen',
    async (_name, load) => {
      const Screen = (await load()).default
      seen.length = 0
      await act(async () => {
        create(createElement(Screen))
      })
      expect(seen).toEqual(['runtime:vm'])
    }
  )
})
