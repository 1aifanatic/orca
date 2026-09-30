/**
 * Live QA, local only: a desktop client paired to a headless Orca server opens a structured Claude
 * chat (an agent-session tab, not a terminal) in a workspace the server owns, and the chat answers,
 * while the server's own structured-chat settings stay off.
 *
 * Runner contract: set ORCA_REMOTE_STRUCTURED_LIVE_QA=1 to opt in. ORCA_QA_CLAUDE_SHIM_DIR must name
 * a directory holding an executable `claude` that execs the real CLI against an already signed-in,
 * disposable config dir. The shim must set CLAUDE_CONFIG_DIR itself: the server runs with an isolated
 * HOME, the E2E harness refuses a CLAUDE_CONFIG_DIR overlay, and Orca strips an inherited one from
 * the Claude child. The shim dir goes first on the server's PATH only. Screenshots are written to
 * ORCA_QA_ARTIFACT_DIR (default test-results/remote-structured-chat-qa). The negative control never
 * runs the real CLI; it puts a stub `claude` on the server's PATH instead.
 *
 * Run:
 *   ORCA_BACKGROUND_LAUNCH=1 ORCA_REMOTE_STRUCTURED_LIVE_QA=1 ORCA_QA_CLAUDE_SHIM_DIR=<dir> \
 *     pnpm exec playwright test tests/e2e/remote-structured-chat-live.qa.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect, forwardElectronProcessLogs, test } from './helpers/orca-app'
import {
  launchHeadlessPairedRuntimeHost,
  type HeadlessPairedRuntimeHost
} from './helpers/headless-paired-runtime-host'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'

const PROMPT = 'Reply with exactly the word PONG and nothing else.'
const ASSISTANT_PONG = /^\s*PONG[.!]?\s*$/
const ARTIFACT_DIR = path.resolve(
  process.env.ORCA_QA_ARTIFACT_DIR ?? path.join('test-results', 'remote-structured-chat-qa')
)
// Why: macOS PTYs otherwise run under login(1), which restores the real account HOME.
const SERVER_ENV_GUARDS = {
  ORCA_DISABLE_MACOS_LOGIN_SHELL: '1',
  DISABLE_AUTOUPDATER: '1'
}

type HostTabRow = {
  type: string
  id: string
  parentTabId?: string
  sessionId?: string
  agent?: string
  launchAgent?: string
}
type HostTabsSnapshot = { worktree: string; tabs: HostTabRow[] }
type ClientTabRow = {
  id: string
  contentType: string
  entityId: string
  agentSessionAgent: string | null
}

test.skip(
  process.env.ORCA_REMOTE_STRUCTURED_LIVE_QA !== '1',
  'live QA only: runs a real Claude CLI'
)
test.skip(process.platform === 'win32', 'live QA rig uses POSIX agent shims')
// Why: both tests launch a server and a client; running them side by side only adds contention.
test.describe.configure({ mode: 'default' })

let cleanups: (() => unknown)[] = []

test.afterEach(async () => {
  const pending = cleanups.toReversed()
  cleanups = []
  const failures: unknown[] = []
  for (const cleanup of pending) {
    try {
      await cleanup()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'remote structured chat QA cleanup failed')
  }
})

function requireClaudeShimDir(): string {
  const dir = process.env.ORCA_QA_CLAUDE_SHIM_DIR
  if (!dir) {
    throw new Error(
      'ORCA_QA_CLAUDE_SHIM_DIR must name a directory containing an executable `claude` shim'
    )
  }
  const shim = path.join(dir, 'claude')
  if (!existsSync(shim) || (statSync(shim).mode & 0o111) === 0) {
    throw new Error('ORCA_QA_CLAUDE_SHIM_DIR does not contain an executable `claude`')
  }
  return path.resolve(dir)
}

function pathWithFirst(dir: string): Record<string, string> {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
  return {
    [pathKey]: [dir, process.env[pathKey] ?? ''].filter(Boolean).join(path.delimiter)
  }
}

function createClaudeStubDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-qa-claude-stub-'))
  const stub = path.join(dir, 'claude')
  writeFileSync(stub, '#!/bin/sh\necho ORCA_QA_CLAUDE_STUB\n')
  chmodSync(stub, 0o755)
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function createServerRepo(): string {
  // Why canonical: git reports realpaths, and the client matches the worktree by path.
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'orca-qa-remote-chat-')))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' })
  writeFileSync(path.join(root, 'README.md'), '# remote structured chat QA\n')
  execFileSync('git', ['add', 'README.md'], { cwd: root, stdio: 'pipe' })
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Orca QA',
      '-c',
      'user.email=orca-qa@example.invalid',
      'commit',
      '-m',
      'seed remote structured chat QA repo'
    ],
    { cwd: root, stdio: 'pipe' }
  )
  return root
}

async function expectServerStructuredChatOff(host: HeadlessPairedRuntimeHost): Promise<void> {
  const { result } = await host.client.call<{ settings: Record<string, unknown> }>('settings.get')
  expect({
    experimentalNativeChat: result.settings.experimentalNativeChat === true,
    openAgentTabsInChatByDefault: result.settings.openAgentTabsInChatByDefault === true,
    experimentalStructuredNativeChat: result.settings.experimentalStructuredNativeChat === true
  }).toEqual({
    experimentalNativeChat: false,
    openAgentTabsInChatByDefault: false,
    experimentalStructuredNativeChat: false
  })
}

async function listHostTabs(
  host: HeadlessPairedRuntimeHost,
  worktreeId: string
): Promise<HostTabRow[]> {
  const { result } = await host.client.call<{ snapshots: HostTabsSnapshot[] }>(
    'session.tabs.listAll',
    undefined,
    { timeoutMs: 20_000 }
  )
  return result.snapshots
    .filter((snapshot) => snapshot.worktree === worktreeId)
    .flatMap((snapshot) => snapshot.tabs)
}

async function readHostTerminalIds(
  host: HeadlessPairedRuntimeHost,
  worktreeId: string
): Promise<string[]> {
  const tabs = await listHostTabs(host, worktreeId)
  return [
    ...new Set(
      tabs.filter((tab) => tab.type === 'terminal').map((tab) => tab.parentTabId ?? tab.id)
    )
  ].sort()
}

/** Activation may seed a shell; take the "before" inventory only once it stops moving. */
async function waitForSettledHostTerminalIds(
  host: HeadlessPairedRuntimeHost,
  worktreeId: string
): Promise<string[]> {
  const deadline = Date.now() + 60_000
  let previous: string | null = null
  let stableSince = Date.now()
  for (;;) {
    const ids = await readHostTerminalIds(host, worktreeId)
    const key = JSON.stringify(ids)
    if (key !== previous) {
      previous = key
      stableSince = Date.now()
    } else if (Date.now() - stableSince >= 3_000) {
      return ids
    }
    if (Date.now() > deadline) {
      throw new Error('server terminal inventory never settled after activation')
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

async function readClientTabs(page: Page, worktreeId: string): Promise<ClientTabRow[]> {
  return page.evaluate(
    (id) =>
      (window.__store?.getState().unifiedTabsByWorktree[id] ?? []).map((tab) => ({
        id: tab.id,
        contentType: tab.contentType,
        entityId: tab.entityId,
        agentSessionAgent: tab.agentSessionAgent ?? null
      })),
    worktreeId
  )
}

async function readClientTerminalTabIds(page: Page, worktreeId: string): Promise<string[]> {
  return page.evaluate(
    (id) => (window.__store?.getState().tabsByWorktree[id] ?? []).map((tab) => tab.id).sort(),
    worktreeId
  )
}

async function settleTerminalInventories(
  host: HeadlessPairedRuntimeHost,
  page: Page,
  worktreeId: string
): Promise<{ host: string[]; client: string[] }> {
  const hostIds = await waitForSettledHostTerminalIds(host, worktreeId)
  await expect
    .poll(async () => (await readClientTerminalTabIds(page, worktreeId)).length, {
      timeout: 30_000,
      message: 'the client never mirrored the server terminals present before the launch'
    })
    .toBe(hostIds.length)
  return { host: hostIds, client: await readClientTerminalTabIds(page, worktreeId) }
}

async function activateServerWorktree(page: Page, repoPath: string): Promise<string> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (targetPath) =>
            window.__store
              ?.getState()
              .allWorktrees()
              .some((worktree) => worktree.path === targetPath) ?? false,
          repoPath
        ),
      { timeout: 120_000, message: 'paired client never received the server-owned workspace' }
    )
    .toBe(true)
  return page.evaluate((targetPath) => {
    const state = window.__store?.getState()
    const worktree = state?.allWorktrees().find((entry) => entry.path === targetPath)
    if (!state || !worktree) {
      throw new Error('server-owned workspace is unavailable in the client')
    }
    state.setActiveRepo(worktree.repoId)
    state.setActiveWorktree(worktree.id)
    return worktree.id
  }, repoPath)
}

async function launchRig(
  testInfo: TestInfo,
  options: { serverPathDir: string; clientStructuredChat: boolean }
): Promise<{
  host: HeadlessPairedRuntimeHost
  client: PairedElectronClient
  worktreeId: string
}> {
  const repoPath = createServerRepo()
  const host = await launchHeadlessPairedRuntimeHost({
    extraEnv: { ...pathWithFirst(options.serverPathDir), ...SERVER_ENV_GUARDS }
  })
  cleanups.push(() => host.dispose())
  forwardElectronProcessLogs(host.app, testInfo)
  await expectServerStructuredChatOff(host)
  await host.client.call('repo.add', { path: repoPath, kind: 'git' })

  const client = await launchPairedElectronClient(
    host.offer,
    testInfo,
    'Remote structured chat QA server'
  )
  cleanups.push(() => client.dispose())
  await client.page.evaluate(async (structured) => {
    const store = window.__store
    if (!store) {
      throw new Error('client store is unavailable')
    }
    await store.getState().updateSettings({
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: true,
      experimentalStructuredNativeChat: structured,
      // Why: otherwise an empty workspace auto-opens the default agent as a chat before the test clicks.
      defaultTuiAgent: 'blank'
    })
  }, options.clientStructuredChat)
  const worktreeId = await activateServerWorktree(client.page, repoPath)
  cleanups.push(() =>
    host.client.call('terminal.stop', { worktree: `id:${worktreeId}` }).catch(() => undefined)
  )
  return { host, client, worktreeId }
}

/** The tab-bar "+" menu entry users pick; it calls launchAgentInNewTab. */
async function launchClaudeFromNewTabMenu(page: Page): Promise<void> {
  const newTab = page.getByRole('button', { name: 'New tab' }).first()
  await expect(newTab).toBeVisible({ timeout: 60_000 })
  await newTab.click({ force: true })
  const claude = page.getByRole('menuitem', { name: /^Claude(?:\s|$)/i }).first()
  // Why long: the entry appears only once the server's agent detection answers.
  await expect(claude).toBeVisible({ timeout: 60_000 })
  await expect(claude).toBeEnabled()
  await claude.click({ force: true })
}

async function captureWindow(page: Page, name: string): Promise<void> {
  mkdirSync(ARTIFACT_DIR, { recursive: true })
  await page.screenshot({ path: path.join(ARTIFACT_DIR, name) })
}

test('a paired client opens a working structured Claude chat on a server whose own chat setting is off', async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires fixture destructuring.
{}, testInfo) => {
  test.setTimeout(420_000)
  const { host, client, worktreeId } = await launchRig(testInfo, {
    serverPathDir: requireClaudeShimDir(),
    clientStructuredChat: true
  })
  const page = client.page

  const { host: hostTerminalsBefore, client: clientTerminalsBefore } =
    await settleTerminalInventories(host, page, worktreeId)
  const agentTabsBefore = new Set(
    (await readClientTabs(page, worktreeId))
      .filter((tab) => tab.contentType === 'agent-session')
      .map((tab) => tab.id)
  )

  await launchClaudeFromNewTabMenu(page)

  let chatTab: ClientTabRow | undefined
  await expect
    .poll(
      async () => {
        chatTab = (await readClientTabs(page, worktreeId)).find(
          (tab) => tab.contentType === 'agent-session' && !agentTabsBefore.has(tab.id)
        )
        return chatTab
          ? { contentType: chatTab.contentType, agent: chatTab.agentSessionAgent }
          : null
      },
      { timeout: 30_000, message: 'the launch did not open an agent-session tab' }
    )
    .toEqual({ contentType: 'agent-session', agent: 'claude' })
  if (!chatTab) {
    throw new Error('agent-session tab disappeared after it was observed')
  }
  const sessionId = chatTab.entityId
  const chatTabId = chatTab.id

  await expect
    .poll(
      async () =>
        (await listHostTabs(host, worktreeId)).some(
          (tab) =>
            tab.type === 'agent-session' && tab.sessionId === sessionId && tab.agent === 'claude'
        ),
      { timeout: 90_000, message: 'the server never published the structured chat tab' }
    )
    .toBe(true)
  // Not a terminal: neither side gained a terminal tab for this launch.
  expect(await readHostTerminalIds(host, worktreeId)).toEqual(hostTerminalsBefore)
  expect(await readClientTerminalTabIds(page, worktreeId)).toEqual(clientTerminalsBefore)

  const chatRoot = page.locator(
    `[data-structured-agent-session-overlay-tab-id="${chatTabId}"] [data-native-chat-root="true"]`
  )
  await expect(chatRoot).toBeVisible({ timeout: 60_000 })
  await captureWindow(page, '01-structured-chat-opened.png')

  const composer = chatRoot.getByRole('textbox').first()
  await expect(composer).toBeEditable({ timeout: 120_000 })
  await composer.click()
  await page.keyboard.type(PROMPT)
  const send = chatRoot.getByRole('button', { name: 'Send', exact: true })
  await expect(send).toBeEnabled({ timeout: 30_000 })
  await send.click()

  // Anchored so the user's own prompt, which also contains PONG, cannot satisfy it.
  await expect(chatRoot.getByText(ASSISTANT_PONG).first()).toBeVisible({ timeout: 120_000 })
  await captureWindow(page, '02-pong-visible.png')

  const tabStripEntry = page
    .locator(
      `[data-testid="sortable-tab"][data-tab-id="${sessionId}"], [data-testid="sortable-tab"][data-tab-id="${chatTabId}"]`
    )
    .first()
  await tabStripEntry.hover()
  await tabStripEntry.getByRole('button', { name: /^Close tab / }).click()

  await expect
    .poll(
      async () => (await readClientTabs(page, worktreeId)).some((tab) => tab.id === chatTabId),
      {
        timeout: 15_000,
        message: 'the client kept the closed chat tab'
      }
    )
    .toBe(false)
  await expect
    .poll(
      async () =>
        (await listHostTabs(host, worktreeId)).some(
          (tab) => tab.type === 'agent-session' && tab.sessionId === sessionId
        ),
      { timeout: 60_000, message: 'the server still lists the closed chat tab' }
    )
    .toBe(false)
  await expectServerStructuredChatOff(host)
})

test('negative control: with the client structured-chat setting off the same launch opens a terminal', async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires fixture destructuring.
{}, testInfo) => {
  test.setTimeout(300_000)
  const { host, client, worktreeId } = await launchRig(testInfo, {
    serverPathDir: createClaudeStubDir(),
    clientStructuredChat: false
  })
  const page = client.page

  const settled = await settleTerminalInventories(host, page, worktreeId)
  const hostTerminalsBefore = settled.host
  const clientTerminalsBefore = new Set(settled.client)
  const agentTabsBefore = new Set(
    (await readClientTabs(page, worktreeId))
      .filter((tab) => tab.contentType === 'agent-session')
      .map((tab) => tab.id)
  )

  await launchClaudeFromNewTabMenu(page)

  await expect
    .poll(
      async () =>
        (await readHostTerminalIds(host, worktreeId)).filter(
          (id) => !hostTerminalsBefore.includes(id)
        ).length,
      { timeout: 60_000, message: 'the server never published a terminal for the launch' }
    )
    .toBe(1)
  await expect
    .poll(
      async () =>
        (await readClientTerminalTabIds(page, worktreeId)).filter(
          (id) => !clientTerminalsBefore.has(id)
        ).length,
      { timeout: 30_000, message: 'the client never mirrored the launched terminal' }
    )
    .toBe(1)
  await captureWindow(page, '03-negative-control-terminal.png')

  expect(
    (await readClientTabs(page, worktreeId)).filter(
      (tab) => tab.contentType === 'agent-session' && !agentTabsBefore.has(tab.id)
    )
  ).toEqual([])
  expect(
    (await listHostTabs(host, worktreeId)).filter((tab) => tab.type === 'agent-session')
  ).toEqual([])
  await expectServerStructuredChatOff(host)
})
