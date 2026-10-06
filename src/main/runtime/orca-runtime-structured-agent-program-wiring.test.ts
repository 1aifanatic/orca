import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionRuntimeDeps } from './structured-agent-session-runtime'
import { resolveClaudeChildEnvSources } from '../claude/claude-structured-launch-resolution'
import { resolveClaudeCommand } from '../codex-cli/command'

const installed = vi.hoisted(() => {
  const holder: { deps: Partial<StructuredAgentSessionRuntimeDeps> | null } = { deps: null }
  return holder
})

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

vi.mock('./structured-agent-session-runtime', () => ({
  ensureStructuredAgentSessionHost: vi.fn(
    async (deps: Partial<StructuredAgentSessionRuntimeDeps>) => {
      installed.deps = deps
    }
  )
}))

import { OrcaRuntimeService } from './orca-runtime'

let root: string
let settings: { agentCmdOverrides: Record<string, string> }

beforeEach(() => {
  installed.deps = null
  root = mkdtempSync(join(tmpdir(), 'orca-runtime-agent-program-'))
  settings = { agentCmdOverrides: {} }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function stub(name: string): string {
  mkdirSync(join(root, 'bin'), { recursive: true })
  const file = join(root, 'bin', name)
  writeFileSync(file, '#!/bin/sh\nexit 0\n')
  chmodSync(file, 0o755)
  return file
}

async function installedDeps(): Promise<Partial<StructuredAgentSessionRuntimeDeps>> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: installing the host reads nothing but store.getSettings(); every other Store member is unreached.
  const runtime = new OrcaRuntimeService({ getSettings: () => settings } as never)
  await runtime.ensureStructuredAgentSessionHost()
  return installed.deps ?? {}
}

/** The deps feed both the session launch and the model-catalog probe; the runtime class does not
 *  typecheck its own `this` calls, so pin the settings read behaviourally. */
describe.skipIf(process.platform === 'win32')('structured agent program wiring', () => {
  it('runs the Codex Command found on the launch PATH, re-read per call', async () => {
    const deps = await installedDeps()
    const wrapper = stub('codex-wrapper')
    const pathEnv = join(root, 'bin')
    settings.agentCmdOverrides = { codex: 'codex-wrapper' }
    expect(deps.resolveCodexCommand?.({ pathEnv, homePath: root })).toBe(wrapper)
    settings.agentCmdOverrides = { codex: 'codex-gone' }
    expect(() => deps.resolveCodexCommand?.({ pathEnv, homePath: root })).toThrow(
      expect.objectContaining({ reason: 'agentCommandNotRunnable' })
    )
  })

  it('runs the Claude Command, re-read per call', async () => {
    const deps = await installedDeps()
    const wrapper = stub('claude-wrapper')
    settings.agentCmdOverrides = { claude: wrapper }
    expect(deps.resolveClaudeCommand?.()).toBe(wrapper)
    settings.agentCmdOverrides = { claude: join(root, 'bin', 'claude-gone') }
    expect(() => deps.resolveClaudeCommand?.()).toThrow(
      expect.objectContaining({ reason: 'agentCommandNotRunnable' })
    )
  })

  it('keeps the stock lookup when no Command is set', async () => {
    const deps = await installedDeps()
    const stock = stub('codex')
    expect(deps.resolveCodexCommand?.({ pathEnv: join(root, 'bin'), homePath: root })).toBe(stock)
    stub('claude')
    // Stock Claude still resolves on Orca's own PATH, not the launch PATH it is handed.
    expect(deps.resolveClaudeCommand?.({ pathEnv: join(root, 'bin'), homePath: root })).toBe(
      resolveClaudeCommand()
    )
  })

  it.each([
    ['a name only the Claude agent env puts on PATH', 'my-claude', undefined],
    ['exactly `claude`, found on the launch PATH', 'claude', join('bin')]
  ])('finds a configured Claude Command given as %s', async (_, name, inheritedBin) => {
    const deps = await installedDeps()
    const resolveCommand = deps.resolveClaudeCommand
    if (!resolveCommand) {
      throw new Error('the runtime installed no Claude program resolver')
    }
    const program = stub(name)
    settings.agentCmdOverrides = { claude: name }
    const sources = await resolveClaudeChildEnvSources({
      resolveCommand,
      resolveInheritedEnv: async () => ({
        PATH: inheritedBin ? join(root, inheritedBin) : join(root, 'empty'),
        HOME: root
      }),
      // Settings → Agents environment for Claude, which spreads over the inherited env.
      resolveEnv: (): Record<string, string> => (inheritedBin ? {} : { PATH: join(root, 'bin') })
    })
    expect(sources.command).toBe(program)
  })
})
