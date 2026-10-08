/**
 * Phone paired with a desktop that is itself a client of an `orca serve` host.
 *
 * BASELINE, not the goal: today the phone sees only the desktop's own workspaces, because the
 * desktop main process never holds its paired servers' workspaces. The mirror slice (S2) flips the
 * second assertion; update it there instead of deleting it.
 */
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { launchPairedElectronClient } from './helpers/paired-electron-client'
import {
  createDesktopMobilePairingOffer,
  pairMobileClient,
  type PairedMobileClient
} from './helpers/paired-mobile-client'
import { RuntimeClient } from '../../src/cli/runtime/client'
import type { RuntimeWorktreePsSummary } from '../../src/shared/runtime-worktree-contracts'

async function phoneWorkspacePaths(phone: PairedMobileClient): Promise<string[]> {
  const { worktrees } = await phone.call<{ worktrees: RuntimeWorktreePsSummary[] }>('worktree.ps', {
    limit: 1_000
  })
  return worktrees.map((row) => realpathSync(row.path))
}

test('baseline until S2: phone paired with a desktop lists its local workspace but not its server workspace', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(120_000)
  const serverFolder = testInfo.outputPath('server-folder')
  mkdirSync(serverFolder, { recursive: true })
  writeFileSync(`${serverFolder}/README.md`, 'server workspace\n')

  const host = await launchHeadlessPairedRuntimeHost()
  let phone: PairedMobileClient | null = null
  try {
    await host.client.call('repo.add', { path: serverFolder, kind: 'folder' })
    const desktop = await launchPairedElectronClient(host.offer, testInfo, 'mirror-desktop')
    try {
      await new RuntimeClient(desktop.userDataDir, 5_000).call('repo.add', {
        path: testRepoPath,
        kind: 'git'
      })
      // Precondition: the desktop window does show the server's workspace.
      await expect
        .poll(() =>
          desktop.page.evaluate(
            (folder) =>
              window.__store
                ?.getState()
                .allWorktrees()
                .some((worktree) => worktree.path === folder) ?? false,
            serverFolder
          )
        )
        .toBe(true)

      phone = pairMobileClient(await createDesktopMobilePairingOffer(desktop.page))
      const paths = await phoneWorkspacePaths(phone)
      expect(paths).toContain(realpathSync(testRepoPath))
      // BASELINE (S2 flips to toContain): the server's workspace is missing from the phone.
      expect(paths).not.toContain(realpathSync(serverFolder))
    } finally {
      phone?.dispose()
      await desktop.dispose()
    }
  } finally {
    await host.dispose()
  }
})
