import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { composeDesktopOwnedSessionTabs } from './desktop-owned-session-tabs'

function terminal(parentTabId: string, leaf: string, isActive = false) {
  return { type: 'terminal', id: `${parentTabId}::${leaf}`, parentTabId, isActive }
}

function browser(id: string) {
  return { type: 'browser', id, browserWorkspaceId: id, isActive: false }
}

function editor(id: string, filePath: string, type: 'file' | 'markdown' = 'file') {
  return { type, id, filePath, isActive: false }
}

function server(tabs: unknown[], activeTabId: string | null = null) {
  return {
    type: 'snapshot',
    worktree: 'w',
    publicationEpoch: 'headless:1',
    snapshotVersion: 4,
    activeTabId,
    activeTabType: activeTabId ? 'terminal' : null,
    tabs
  }
}

function desktop(tabs: unknown[], desktopTabOrder: string[], activeTabId: string | null = null) {
  return {
    worktree: 'w',
    publicationEpoch: 'renderer:1',
    snapshotVersion: 2,
    activeTabId,
    activeTabType: activeTabId ? 'file' : null,
    tabGroups: [{ id: 'g', activeTabId, tabOrder: tabs.map(() => ''), desktopTabOrder }],
    tabs
  }
}

const ids = (result: unknown) =>
  z
    .looseObject({ tabs: z.array(z.looseObject({ id: z.string() })) })
    .parse(result)
    .tabs.map((tab) => tab.id)

describe("a server workspace's strip with the desktop's own tabs", () => {
  it('places each desktop tab where the desktop shows it, after every pane of a split terminal', () => {
    const { result, desktopTabIds } = composeDesktopOwnedSessionTabs(
      server([terminal('t1', 'a'), terminal('t1', 'b'), browser('p1')]),
      desktop([editor('e1', '/a.ts'), editor('e2', '/b.md', 'markdown')], ['e1', 't1', 'e2', 'p1'])
    )

    expect(ids(result)).toEqual(['e1', 't1::a', 't1::b', 'e2', 'p1'])
    expect([...desktopTabIds]).toEqual(['e1', 'e2'])
  })

  it('keeps tabs the desktop order does not name: server ones in place, desktop ones last', () => {
    const { result } = composeDesktopOwnedSessionTabs(
      server([terminal('t1', 'a'), terminal('new', 'a')]),
      desktop([editor('e1', '/a.ts'), editor('e2', '/b.ts')], ['t1', 'e1'])
    )

    expect(ids(result)).toEqual(['t1::a', 'e1', 'new::a', 'e2'])
  })

  it("lists an editor tab the server persisted once, as the desktop's", () => {
    const { result, desktopTabIds } = composeDesktopOwnedSessionTabs(
      server([editor('server-readme', '/README.md', 'markdown'), terminal('t1', 'a')]),
      desktop([editor('desktop-readme', '/README.md', 'markdown')], ['desktop-readme', 't1'])
    )

    expect(ids(result)).toEqual(['desktop-readme', 't1::a'])
    expect(desktopTabIds.has('desktop-readme')).toBe(true)
  })

  it("keeps the server's selection, and takes the desktop's only when the server has none", () => {
    const withServerPick = composeDesktopOwnedSessionTabs(
      server([terminal('t1', 'a', true)], 't1::a'),
      desktop([editor('e1', '/a.ts')], ['t1', 'e1'], 'e1')
    ).result
    expect(withServerPick).toMatchObject({
      activeTabId: 't1::a',
      tabs: [
        { id: 't1::a', isActive: true },
        { id: 'e1', isActive: false }
      ]
    })

    const withoutServerPick = composeDesktopOwnedSessionTabs(
      server([]),
      desktop([editor('e1', '/a.ts')], ['e1'], 'e1')
    ).result
    expect(withoutServerPick).toMatchObject({
      activeTabId: 'e1',
      activeTabType: 'file',
      tabs: [{ id: 'e1', isActive: true }]
    })
  })

  it("reads as newer when either side changes, and keeps the server's stream fields", () => {
    const before = composeDesktopOwnedSessionTabs(server([]), desktop([], [])).result
    const after = composeDesktopOwnedSessionTabs(server([]), {
      ...desktop([], []),
      snapshotVersion: 3
    }).result

    expect(before).toMatchObject({
      type: 'snapshot',
      worktree: 'w',
      publicationEpoch: 'headless:1|desktop:renderer:1',
      snapshotVersion: 6
    })
    expect(after).toMatchObject({ snapshotVersion: 7 })
  })

  it("passes the server's frame through when the desktop has no strip to add", () => {
    const serverFrame = server([terminal('t1', 'a')])

    expect(composeDesktopOwnedSessionTabs(serverFrame, { type: 'end' })).toEqual({
      result: serverFrame,
      desktopTabIds: new Set()
    })
  })
})
