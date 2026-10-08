import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveCodexMaintenanceCommand } from './codex-maintenance-command'
import {
  configuredCodexInvocationSources,
  type CodexCommandSettings
} from '../codex/configured-codex-invocation'
import { createStructuredAgentEnvironmentResolvers } from '../runtime/structured-agent-shell-environment'
import { resolveCodexStructuredInvocation } from '../codex/codex-structured-launch-resolution'

const { run, shell } = vi.hoisted(() => ({ run: vi.fn(), shell: vi.fn() }))
vi.mock('../../shared/child-process/run-process', async (original) => ({
  ...(await original<object>()),
  runProcess: run
}))
vi.mock('../startup/login-shell-environment', () => ({ resolveLoginShellEnvironment: shell }))
let root: string
async function executable(name: string): Promise<string> {
  const file = join(root, name)
  await writeFile(file, 'fake executable; never executed')
  await chmod(file, 0o755)
  return file
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'codex-configured-'))
  shell.mockResolvedValue({ PATH: root, HOME: root, SHELL_SETTING: 'inherited' })
  run.mockImplementation(async (spec: { program: string }) => ({
    code: 0,
    stdout: spec.program.endsWith('old-codex') ? 'codex-cli 0.135.0' : 'codex-cli 0.136.0',
    stderr: '',
    timedOut: false
  }))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('configured Codex invocation ownership', () => {
  it('keeps the native command refusal for an unresolvable custom command without installing stock Codex', async () => {
    const command = join(root, 'missing-custom-codex')
    await expect(
      resolveCodexMaintenanceCommand({
        cwd: root,
        commandSettings: { agentCmdOverrides: { codex: command } }
      })
    ).rejects.toThrow('Command setting is not a runnable program')
    expect(run).not.toHaveBeenCalled()
  })

  it('uses the same custom executable, overlay and directory for maintenance and native invocation', async () => {
    const command = await executable('company-codex')
    await executable('codex')
    const cwd = root
    const settings: CodexCommandSettings = {
      agentCmdOverrides: { codex: command },
      agentDefaultEnv: { codex: { PATH: root, COMPANY_SELECTION: 'current' } },
      nativeChatInheritShellEnvironment: false,
      nativeChatShellEnvironmentVariables: ['SHELL_SETTING']
    }
    const sources = configuredCodexInvocationSources(() => settings)
    const environment = createStructuredAgentEnvironmentResolvers(sources)
    const native = await resolveCodexStructuredInvocation({
      resolveCommand: sources.resolveCommand,
      resolveEnvironment: environment.resolveCodexEnvironment
    })
    const maintenance = await resolveCodexMaintenanceCommand({ cwd, commandSettings: settings })
    expect(maintenance.installation.status).toBe('ready')
    expect(native.command).toBe(command)
    const probe = run.mock.calls.at(-1)?.[0]
    expect(probe.program).toBe(native.command)
    expect(probe.cwd).toBe(cwd)
    expect(probe.env.COMPANY_SELECTION).toBe(native.environment?.COMPANY_SELECTION)
    expect(probe.env.PATH).toBe(native.environment?.PATH)
    expect(probe.env.SHELL_SETTING).toBe('inherited')
  })

  it('binds the update and verification to the selected custom install after settings change', async () => {
    const command = await executable('old-codex')
    const settings: CodexCommandSettings = { agentCmdOverrides: { codex: command } }
    const result = await resolveCodexMaintenanceCommand({ cwd: root, commandSettings: settings })
    expect(result.spec?.program).toBe(command)
    expect(result.spec?.cwd).toBe(root)
    expect(result.spec?.args).toEqual(['update'])
    settings.agentCmdOverrides = { codex: await executable('company-codex') }
    const rechecked = await result.recheck?.()
    expect(rechecked?.spec?.program).toBe(command)
  })

  it('honors the configured PATH even without an explicit Command', async () => {
    const command = await executable('codex')
    const settings: CodexCommandSettings = { agentDefaultEnv: { codex: { PATH: root } } }
    await resolveCodexMaintenanceCommand({ cwd: root, commandSettings: settings })
    expect(run.mock.calls.at(-1)?.[0].program).toBe(command)
  })

  it('offers manual repair for an old custom install that lacks self-update, without starting stock npm', async () => {
    const command = await executable('company-codex')
    run.mockResolvedValue({ code: 0, stdout: 'codex-cli 0.100.0', stderr: '', timedOut: false })
    const result = await resolveCodexMaintenanceCommand({
      cwd: root,
      commandSettings: { agentCmdOverrides: { codex: command } }
    })
    expect(result.spec).toBeNull()
    expect(result.action).toMatchObject({ kind: 'update', installationPath: command, manual: true })
    expect(result.action?.command).toBe(
      `Install or update Codex at ${command} to 0.136.0 or newer, then try again.`
    )
  })
})
