/**
 * A server workspace's editor tabs live in the desktop's window, not on the server. The phone lists
 * them from the desktop beside the server's tabs, in the desktop's order, and opens and reads them
 * through the desktop.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { expect, test } from './helpers/orca-app'
import { launchPhoneMirrorTopology } from './helpers/phone-mirror-topology'
import type { PairedMobileSocket } from './helpers/paired-mobile-client'
import { composeDesktopOwnedSessionTabs } from '../../mobile/src/transport/desktop-owned-session-tabs'
import { MOBILE_DESKTOP_OWNED_TABS_RUNTIME_CAPABILITY } from '../../src/shared/mobile-desktop-relay-contract'

const TabsSchema = z.looseObject({
  tabs: z.array(z.looseObject({ id: z.string(), type: z.string() }))
})
const ReadTabSchema = z.looseObject({ content: z.string() })

let requestId = 0
async function call(
  socket: PairedMobileSocket,
  method: string,
  params: unknown,
  executionHost?: string
): Promise<{ ok: boolean; result?: unknown }> {
  requestId += 1
  const id = `owned-${requestId}`
  socket.send(id, method, params, executionHost)
  let frame: PairedMobileSocket['frames'][number] | undefined
  await expect
    .poll(() => (frame = socket.frames.find((candidate) => candidate.id === id)), {
      timeout: 30_000
    })
    .toBeDefined()
  return frame!
}

const TITLE = "phone lists, places and opens the desktop's editor tabs in a server workspace"
// oxlint-disable-next-line no-empty-pattern -- the topology launches its own desktop, so no app fixture.
test(TITLE, async ({}, testInfo) => {
  test.setTimeout(180_000)
  const serverRepo = testInfo.outputPath('server-repo')
  mkdirSync(serverRepo, { recursive: true })
  writeFileSync(path.join(serverRepo, 'NOTES.md'), 'notes on the server\n')
  writeFileSync(path.join(serverRepo, 'a.ts'), 'export const a = 1\n')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: serverRepo, stdio: 'pipe' })
  git('init')
  git('add', '.')
  git('-c', 'user.name=E2E', '-c', 'user.email=e2e@test.local', 'commit', '-m', 'init')

  const { host, desktop, phone, dispose } = await launchPhoneMirrorTopology(
    { phoneTo: 'desktop' },
    testInfo
  )
  try {
    await host.client.call('repo.add', { path: serverRepo, kind: 'git' })
    let row: { id: string; hostId: string } | null = null
    await expect
      .poll(
        async () =>
          (row = await desktop.page.evaluate((folder) => {
            const worktree = window.__store
              ?.getState()
              .allWorktrees()
              .find((candidate) => candidate.path === folder)
            return worktree?.hostId?.startsWith('runtime:')
              ? { id: worktree.id, hostId: worktree.hostId }
              : null
          }, serverRepo)),
        { timeout: 30_000 }
      )
      .not.toBeNull()
    const { id: worktreeId, hostId } = row!
    const worktree = `id:${worktreeId}`
    const socket = await phone.openSocket()
    const status = z
      .looseObject({ capabilities: z.array(z.string()) })
      .parse((await call(socket, 'status.get', {})).result)
    expect(status.capabilities).toContain(MOBILE_DESKTOP_OWNED_TABS_RUNTIME_CAPABILITY)

    // The phone opens a file on the server workspace; the desktop's window holds the tab.
    const opened = await call(socket, 'files.open', { worktree, relativePath: 'NOTES.md' }, hostId)
    expect(opened).toMatchObject({ ok: true, result: { opened: true } })
    await desktop.page.evaluate(
      ({ id, repo, environmentId }) =>
        window.__store?.getState().openFile(
          {
            filePath: `${repo}/a.ts`,
            relativePath: 'a.ts',
            worktreeId: id,
            language: 'typescript',
            runtimeEnvironmentId: environmentId,
            mode: 'edit'
          },
          { preview: false }
        ),
      { id: worktreeId, repo: serverRepo, environmentId: hostId.slice('runtime:'.length) }
    )

    // The desktop's strip, with each tab named as the phone's lists name it.
    const desktopStrip = () =>
      desktop.page.evaluate((id) => {
        const state = window.__store!.getState()
        const tabs = state.unifiedTabsByWorktree[id] ?? []
        return (state.groupsByWorktree[id] ?? []).flatMap((group) =>
          group.tabOrder.map((tabId) => {
            const tab = tabs.find((candidate) => candidate.id === tabId)
            return tab?.contentType === 'editor'
              ? `editor:${tab.entityId.split('/').pop()}`
              : `${tab?.contentType}`
          })
        )
      }, worktreeId)
    const phoneStrip = async () => {
      const server = await call(socket, 'session.tabs.list', { worktree }, hostId)
      const own = await call(socket, 'session.tabs.list', { worktree })
      const composed = TabsSchema.parse(
        composeDesktopOwnedSessionTabs(server.result, own.result).result
      )
      return composed.tabs.map((tab) =>
        tab.type === 'file' || tab.type === 'markdown'
          ? `editor:${z.looseObject({ relativePath: z.string() }).parse(tab).relativePath}`
          : tab.type
      )
    }
    await expect
      .poll(async () => (await phoneStrip()).filter((entry) => entry.startsWith('editor:')), {
        timeout: 30_000
      })
      .toEqual(['editor:NOTES.md', 'editor:a.ts'])
    expect(await phoneStrip()).toEqual(await desktopStrip())
    // The desktop moves its tab past the server's terminal; the phone follows.
    await desktop.page.evaluate((id) => {
      const state = window.__store!.getState()
      const group = state.groupsByWorktree[id]![0]!
      const editor = state.unifiedTabsByWorktree[id]!.find((tab) => tab.entityId.endsWith('/a.ts'))!
      state.reorderUnifiedTabs(group.id, [
        ...group.tabOrder.filter((tabId) => tabId !== editor.id),
        editor.id
      ])
    }, worktreeId)
    await expect
      .poll(phoneStrip, { timeout: 30_000 })
      .toEqual(['editor:NOTES.md', 'terminal', 'editor:a.ts'])
    expect(await desktopStrip()).toEqual(['editor:NOTES.md', 'terminal', 'editor:a.ts'])

    // A desktop tab reads through the desktop, even on the server workspace's client.
    const own = TabsSchema.parse((await call(socket, 'session.tabs.list', { worktree })).result)
    const notes = own.tabs.find((tab) => tab.type === 'markdown')
    const read = await call(socket, 'markdown.readTab', { worktree, tabId: notes?.id }, hostId)
    expect(ReadTabSchema.parse(read.result).content).toBe('notes on the server\n')
  } finally {
    await dispose()
  }
})
