import path from 'node:path'
import { z } from 'zod'
import { RuntimeClient } from '../../../src/cli/runtime/client'
import { runProcess } from '../../../src/shared/child-process/run-process'
import type {
  RuntimeTerminalListResult,
  RuntimeTerminalSummary
} from '../../../src/shared/runtime-types'
import { expect } from './orca-app'

const terminalResult = z.object({
  ok: z.literal(true),
  result: z.object({
    terminal: z.object({ handle: z.string(), tabId: z.string(), worktreeId: z.string() })
  })
})
const splitResult = z.object({
  ok: z.literal(true),
  result: z.object({ split: z.object({ handle: z.string(), tabId: z.string() }) })
})

export function ratioLaunchEnv(userDataDir: string): Record<string, string> {
  return {
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_DEV_USER_DATA_PATH: userDataDir,
    ORCA_DEV_REPO_ROOT: process.cwd(),
    ORCA_DEV_CLI_ENTRY_PATH: path.join(process.cwd(), 'out', 'cli', 'index.js'),
    ...(process.platform === 'win32'
      ? {
          APPDATA: path.join(userDataDir, 'appData'),
          LOCALAPPDATA: path.join(userDataDir, 'localAppData')
        }
      : {})
  }
}

export async function runRatioCli(userDataDir: string, args: string[]) {
  const result = await runProcess({
    program: process.execPath,
    args: [path.join(process.cwd(), 'config', 'scripts', 'orca-dev.mjs'), ...args, '--json'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...ratioLaunchEnv(userDataDir)
    },
    timeoutMs: 30_000
  })
  expect(result, `CLI ${args.join(' ')}`).toMatchObject({ code: 0, timedOut: false })
  return result
}

export async function createRatioTerminal(userDataDir: string, worktreeId: string, label: string) {
  const raw = await runRatioCli(userDataDir, [
    'terminal',
    'create',
    '--worktree',
    `id:${worktreeId}`,
    '--title',
    label
  ])
  return { raw, terminal: terminalResult.parse(JSON.parse(raw.stdout)).result.terminal }
}

export async function splitRatioTerminal(
  userDataDir: string,
  handle: string,
  direction: string,
  ratio?: number
) {
  const args = ['terminal', 'split', '--terminal', handle, '--direction', direction]
  if (ratio !== undefined) {
    args.push('--ratio', String(ratio))
  }
  const raw = await runRatioCli(userDataDir, args)
  return { raw, split: splitResult.parse(JSON.parse(raw.stdout)).result.split }
}

export async function waitForRatioTerminals(
  userDataDir: string,
  worktreeId: string,
  tabId: string,
  count: number
): Promise<RuntimeTerminalSummary[]> {
  const client = new RuntimeClient(userDataDir, 30_000)
  let terminals: RuntimeTerminalSummary[] = []
  await expect
    .poll(
      async () => {
        const listed = await client.call<RuntimeTerminalListResult>('terminal.list', {
          worktree: `id:${worktreeId}`,
          limit: 100,
          requireFreshPtyLiveness: true
        })
        terminals = listed.result.terminals.filter((terminal) => terminal.tabId === tabId)
        return (
          terminals.length === count &&
          terminals.every(
            (terminal) =>
              terminal.connected && terminal.writable && terminal.ptyId && terminal.incarnationId
          )
        )
      },
      { timeout: 60_000, message: `Ratio tab ${tabId} did not have ${count} live native PTYs` }
    )
    .toBe(true)
  return terminals
}
