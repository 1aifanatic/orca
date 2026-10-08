/**
 * A phone paired directly with `orca serve` still lists a `terminal.create` terminal after the
 * serve process restarts (an update does this). Regression oracle for #26022: the cold-start
 * hydrate used to keep only serve-minted PTYs, so CLI and agent terminals vanished from the phone.
 */
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { pairMobileClient, type PairedMobileClient } from './helpers/paired-mobile-client'
import type { RuntimeWorktreePsSummary } from '../../src/shared/runtime-worktree-contracts'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-session-contracts'

async function listedPtyIds(phone: PairedMobileClient, worktreeId: string): Promise<string[]> {
  const listed = await phone.request<RuntimeMobileSessionTabsResult>('session.tabs.list', {
    worktree: `id:${worktreeId}`
  })
  return listed.ok ? terminalPtyIds(listed.result) : [`refused:${listed.error.code}`]
}

function terminalPtyIds(snapshot: RuntimeMobileSessionTabsResult): string[] {
  return snapshot.tabs.flatMap((tab) => (tab.type === 'terminal' && tab.ptyId ? [tab.ptyId] : []))
}

test('phone paired with orca serve keeps a terminal.create terminal across a serve restart', async ({
  testRepoPath
}) => {
  test.setTimeout(120_000)
  const host = await launchHeadlessPairedRuntimeHost({
    pairingScope: 'mobile',
    pinnedServePort: true
  })
  const phone = pairMobileClient(host.offer)
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    const { worktrees } = await phone.call<{ worktrees: RuntimeWorktreePsSummary[] }>(
      'worktree.ps',
      { limit: 1_000 }
    )
    const worktreeId = worktrees.find((row) => row.path === testRepoPath)?.worktreeId ?? ''
    expect(worktreeId, 'the phone lists the serve host workspace').not.toBe('')

    // Why both: the bug kept serve-minted PTYs (the phone's own create) and dropped daemon-minted ones.
    await phone.call('session.tabs.createTerminal', {
      worktree: `id:${worktreeId}`,
      activate: false,
      select: true,
      navigation: 'caller'
    })
    const created = await host.client.call<{ terminal: { ptyId?: string | null } }>(
      'terminal.create',
      { worktree: `path:${testRepoPath}`, title: 'cli-created' }
    )
    const cliPtyId = created.result.terminal.ptyId ?? ''
    expect(cliPtyId, 'terminal.create reports its PTY').not.toBe('')
    await expect.poll(() => listedPtyIds(phone, worktreeId)).toHaveLength(2)
    const beforeRestart = await listedPtyIds(phone, worktreeId)
    expect(beforeRestart).toContain(cliPtyId)

    await host.restartServeProcess()

    await expect
      .poll(async () => (await listedPtyIds(phone, worktreeId)).sort(), { timeout: 30_000 })
      .toEqual([...beforeRestart].sort())
    // The phone's session strip is built from this stream's first snapshot.
    let snapshotPtyIds: string[] | null = null
    await phone.subscribe<{ type: string } & RuntimeMobileSessionTabsResult>(
      'session.tabs.subscribe',
      { worktree: `id:${worktreeId}` },
      {
        onResponse: (response) => {
          if (response.ok && response.result.type === 'snapshot' && !snapshotPtyIds) {
            snapshotPtyIds = terminalPtyIds(response.result)
          }
        },
        onError: () => {}
      }
    )
    await expect.poll(() => snapshotPtyIds?.sort() ?? null).toEqual([...beforeRestart].sort())
  } finally {
    phone.dispose()
    await host.dispose()
  }
})
