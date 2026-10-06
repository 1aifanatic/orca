/**
 * A paired client opening a host worktree the host's own window has never opened must get its first
 * terminal. Such a worktree has no published tab graph on the host, yet the host is fully started.
 *
 * Run:
 *   ORCA_BACKGROUND_LAUNCH=1 pnpm exec playwright test \
 *     tests/e2e/paired-client-first-terminal-unopened-host-worktree.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
import { existsSync, readFileSync } from 'node:fs'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { createRestartSession } from './helpers/orca-restart'

function seededRepoPathOrSkip(): string {
  const repoPath = existsSync(TEST_REPO_PATH_FILE)
    ? readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
    : ''
  test.skip(!repoPath || !existsSync(repoPath), 'Global setup did not produce a seeded test repo')
  return repoPath
}

async function callRuntime<TResult>(
  page: Page,
  environmentId: string,
  method: string,
  params: unknown
): Promise<TResult> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test-only RPC result shape.
  return page.evaluate(
    async ({ environmentId, method, params }) => {
      const response = await window.api.runtimeEnvironments.call({
        selector: environmentId,
        method,
        params
      })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    { environmentId, method, params }
  ) as Promise<TResult>
}

function hostTerminalCount(page: Page, environmentId: string, worktreeId: string): Promise<number> {
  return callRuntime<{ tabs: { type: string }[] }>(page, environmentId, 'session.tabs.list', {
    worktree: `id:${worktreeId}`
  }).then((listed) => listed.tabs.filter((tab) => tab.type === 'terminal').length)
}

test('a paired client gets a first terminal in a host worktree the host never opened', async (// oxlint-disable-next-line no-empty-pattern -- This test owns its host launch.
{}, testInfo) => {
  test.setTimeout(240_000)
  const repoPath = seededRepoPathOrSkip()
  const session = createRestartSession(testInfo)
  let host: ElectronApplication | null = null
  let client: PairedElectronClient | null = null
  try {
    const launched = await session.launch()
    host = launched.app
    client = await launchPairedElectronClient(
      await createRuntimeDesktopPairingOffer(launched.page),
      testInfo,
      'first-terminal-unopened-worktree'
    )
    // Added through the host's runtime, so the host's own window never opens the worktree.
    await callRuntime(client.page, client.environmentId, 'repo.add', {
      path: repoPath,
      kind: 'git'
    })
    const worktreeId = await expect
      .poll(
        () =>
          client!.page.evaluate(
            (path) =>
              window.__store
                ?.getState()
                .allWorktrees()
                .find((worktree) => worktree.path === path)?.id ?? null,
            repoPath
          ),
        { timeout: 60_000, message: 'Paired client never saw the host worktree' }
      )
      .not.toBeNull()
      .then(() =>
        client!.page.evaluate(
          (path) =>
            window.__store
              ?.getState()
              .allWorktrees()
              .find((worktree) => worktree.path === path)?.id ?? '',
          repoPath
        )
      )
    // Precondition: the host is started but has published nothing for this worktree.
    expect(await hostTerminalCount(client.page, client.environmentId, worktreeId)).toBe(0)

    await client.page.evaluate((id) => {
      const state = window.__store?.getState()
      state?.setActiveView('terminal')
      state?.setActiveWorktree(id)
    }, worktreeId)

    await expect
      .poll(() => hostTerminalCount(client!.page, client!.environmentId, worktreeId), {
        timeout: 45_000,
        message: 'Opening the worktree on the paired client never created its first terminal'
      })
      .toBe(1)
    await expect
      .poll(
        () =>
          client!.page.evaluate(
            (id) =>
              (window.__store?.getState().tabsByWorktree[id] ?? []).filter(
                (tab) => tab.contentType !== 'browser'
              ).length,
            worktreeId
          ),
        { timeout: 30_000, message: 'The paired client never showed the first terminal tab' }
      )
      .toBeGreaterThan(0)
  } finally {
    if (client) {
      await client.dispose()
    }
    if (host) {
      await session.close(host)
    }
    await session.dispose()
  }
})
