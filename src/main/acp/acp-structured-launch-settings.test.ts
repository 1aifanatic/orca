// A Grok chat's launch under the saved Command and Arguments, composed as the runtime composes it,
// against a real install directory: untouched settings must launch exactly what a chat did before.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { resolvedTuiAgentArgsBypassPermissions } from '../../shared/tui-agent-launch-defaults'
import { resolveStructuredAgentCommand } from '../native-chat/structured-agent-command-resolution'
import { structuredAgentConfiguredArgs } from '../native-chat/structured-agent-configured-args'
import { acpLaunchSpecFor } from './acp-launch-specs'
import { createAcpStructuredLaunchResolver } from './acp-structured-launch-resolution'

const GROK = acpLaunchSpecFor('grok')!
const identity = {
  sessionId: 'session-alpha-1',
  workspaceId: 'workspace-1',
  hostId: 'local',
  agent: 'grok',
  providerHandle: null
}
const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function executable(path: string): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '#!/bin/sh\n')
  chmodSync(path, 0o755)
  return path
}

/** A home whose Grok is installed only in `$GROK_HOME/bin`, not on PATH. */
function grokHome() {
  const root = mkdtempSync(join(tmpdir(), 'orca-grok-launch-'))
  scratch.push(root)
  const grokHomePath = join(root, 'home', '.grok')
  return {
    root,
    grokHomePath,
    installed: executable(join(grokHomePath, 'bin', 'grok')),
    env: { PATH: join(root, 'empty-bin'), HOME: join(root, 'home') }
  }
}

function launchUnder(
  settings: Partial<GlobalSettings>,
  home: ReturnType<typeof grokHome>,
  withSettings = true
) {
  return createAcpStructuredLaunchResolver(GROK, {
    store: {
      getRecord: () => ({
        ...agentSessionRecordFixture(),
        provider: 'grok',
        providerHandleChain: [],
        accountHome: { variable: 'GROK_HOME', path: home.grokHomePath }
      })
    },
    readJournal: () => null,
    resolveWorkspacePath: async () => '/repo/worktree',
    resolveEnvironment: async () => home.env,
    resolveFullAccess: (agent) =>
      agent === 'grok' && resolvedTuiAgentArgsBypassPermissions('grok', settings, process.platform),
    resolveLaunchArgs: () => (withSettings ? structuredAgentConfiguredArgs('grok', settings) : []),
    // Without settings: the stock lookup every chat made before the Command was read.
    ...(withSettings
      ? {
          resolveCommand: (agent: string, options: Parameters<typeof resolveCliCommand>[1]) =>
            resolveStructuredAgentCommand(agent, settings, options)
        }
      : {})
  })({ identity })
}

describe.skipIf(process.platform === 'win32')('a Grok chat under its saved Command', () => {
  // Agent Permissions is the Arguments field: absent is the shipped bypass default, '' is Manual.
  it.each<[string, Partial<GlobalSettings>, string[]]>([
    ['untouched (the shipped default)', {}, ['agent', '--always-approve', 'stdio']],
    ['Manual', { agentDefaultArgs: { grok: '' } }, ['agent', 'stdio']]
  ])(
    'launches what it did before with a blank Command and %s Arguments',
    async (_label, settings, argv) => {
      const home = grokHome()
      const before = await launchUnder(settings, home, false)
      const now = await launchUnder(settings, home)
      expect(now.command).toBe(home.installed)
      expect(now.command).toBe(before.command)
      expect(now.command).toBe(
        resolveCliCommand('grok', {
          pathEnv: [home.env.PATH, join(home.grokHomePath, 'bin')].join(delimiter),
          homePath: home.env.HOME
        })
      )
      expect(now.args).toEqual(argv)
      expect(now.fullAccess).toBe(argv.includes('--always-approve'))
    }
  )

  it('runs a saved Command that names a program, and refuses one that names none', async () => {
    const home = grokHome()
    const nightly = executable(join(home.root, 'opt', 'grok-nightly'))
    await expect(
      launchUnder({ agentCmdOverrides: { grok: nightly } }, home)
    ).resolves.toMatchObject({ command: nightly })
    await expect(
      launchUnder({ agentCmdOverrides: { grok: join(home.root, 'missing', 'grok') } }, home)
    ).rejects.toMatchObject({ reason: 'agentCommandNotRunnable' })
    await expect(
      launchUnder({ agentCmdOverrides: { grok: 'grok --debug' } }, home)
    ).rejects.toMatchObject({ reason: 'agentCommandNotRunnable' })
  })

  it('refuses saved Arguments a chat cannot honor, by name', async () => {
    const home = grokHome()
    await expect(
      launchUnder({ agentDefaultArgs: { grok: '--cwd /elsewhere' } }, home)
    ).rejects.toMatchObject({
      argumentProblem: { agent: 'Grok', option: '--cwd', problem: 'unsupportedOption' }
    })
    await expect(
      launchUnder({ agentDefaultArgs: { grok: '--model "grok' } }, home)
    ).rejects.toMatchObject({
      argumentProblem: { agent: 'Grok', option: 'quote', problem: 'unclosedQuote' }
    })
  })
})
