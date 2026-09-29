import { describe, expect, it, vi } from 'vitest'
import { buildAgentResumeLaunchCommand } from '../../../../shared/agent-resume-launch-command'
import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session-resume'
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../../../shared/setup-agent-sequencing'
import type { AgentStartupShell } from '../../../../shared/tui-agent-startup-shell'
import type { CodexSessionHookTrust } from '../../../codex/codex-real-home-session-hook-trust'
import type { CodexSessionResumePreparation } from '../../../codex/codex-session-resume-home'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/orca-user-data' } }))

const { formatCodexSessionHookTrustOverride } =
  await import('../../../codex/codex-real-home-session-hook-trust')
const {
  resolveCodexResumeLaunch,
  resolveCodexResumeStartupShell,
  rewriteSequencedStartupResumeArgv
} = await import('./codex-resume')

// Why this file: a resume into the real ~/.codex carries Orca's not-yet-approved
// hook trust as a `-c` flag typed into the pane's shell; each shell must hand
// Codex the exact bytes.

const SESSION: AgentProviderSessionMetadata = { key: 'session_id', id: '019abc' }
const POSIX_TRUST: CodexSessionHookTrust[] = [
  { key: '/Users/me/.codex/hooks.json:stop:1:0', trustedHash: 'sha256:ab12' }
]
const WINDOWS_TRUST: CodexSessionHookTrust[] = [
  { key: 'C:\\Users\\me\\.codex\\hooks.json:stop:1:0', trustedHash: 'sha256:ab12' }
]

function resumeCommand(shell: AgentStartupShell): string {
  return buildAgentResumeLaunchCommand('codex', 'codex', ['codex', 'resume', SESSION.id], shell)
}

function launchWith(
  shell: AgentStartupShell,
  prepared: CodexSessionResumePreparation | null,
  command = resumeCommand(shell)
): ReturnType<typeof resolveCodexResumeLaunch> {
  return resolveCodexResumeLaunch(command, {
    providerSession: SESSION,
    preparation: Promise.resolve(prepared),
    startupShell: shell
  })
}

function resumeHome(sessionHookTrust?: CodexSessionHookTrust[]): CodexSessionResumePreparation {
  return { outcome: 'resume', codexHomePath: '/Users/me/.codex', sessionHookTrust }
}

describe('the -c value that trusts Orca entries for one Codex process', () => {
  it('is one inline table of TOML literal strings, since Codex splits a -c key on every dot', () => {
    expect(
      formatCodexSessionHookTrustOverride([
        ...POSIX_TRUST,
        { key: '/Users/me/.codex/hooks.json:session_start:2:0', trustedHash: 'sha256:cd34' }
      ])
    ).toBe(
      "hooks.state={'/Users/me/.codex/hooks.json:stop:1:0'={trusted_hash='sha256:ab12'}," +
        "'/Users/me/.codex/hooks.json:session_start:2:0'={trusted_hash='sha256:cd34'}}"
    )
  })

  it('is withheld when a key cannot be a TOML literal string', () => {
    expect(
      formatCodexSessionHookTrustOverride([
        { key: "/Users/o'brien/.codex/hooks.json:stop:1:0", trustedHash: 'sha256:ab12' }
      ])
    ).toBeNull()
    expect(formatCodexSessionHookTrustOverride([])).toBeNull()
  })
})

describe('a resume command carrying session hook trust', () => {
  it('quotes it for every Unix shell, before the resume argv', async () => {
    const launch = await launchWith('posix', resumeHome(POSIX_TRUST))
    expect(launch.command).toBe(
      "codex '-c' 'hooks.state={'\"'\"'/Users/me/.codex/hooks.json:stop:1:0'\"'\"'" +
        "={trusted_hash='\"'\"'sha256:ab12'\"'\"'}}' 'resume' '019abc'"
    )
  })

  it('quotes it for PowerShell without a double quote in the argument', async () => {
    const launch = await launchWith('powershell', resumeHome(WINDOWS_TRUST))
    expect(launch.command).toBe(
      "codex '-c' 'hooks.state={''C:\\Users\\me\\.codex\\hooks.json:stop:1:0''" +
        "={trusted_hash=''sha256:ab12''}}' 'resume' '019abc'"
    )
  })

  it('quotes it for cmd', async () => {
    const launch = await launchWith('cmd', resumeHome(WINDOWS_TRUST))
    expect(launch.command).toBe(
      'codex "-c" "hooks.state={\'C:\\Users\\me\\.codex\\hooks.json:stop:1:0\'' +
        '={trusted_hash=\'sha256:ab12\'}}" "resume" "019abc"'
    )
  })

  it('leaves a cmd line unchanged when the path holds a character cmd would expand', async () => {
    const trust = [{ ...WINDOWS_TRUST[0]!, key: 'C:\\Users\\me%x%\\.codex\\hooks.json:stop:1:0' }]
    const launch = await launchWith('cmd', resumeHome(trust))
    expect(launch.command).toBe(resumeCommand('cmd'))
    expect(launch.sessionHookTrustArgs).toBeNull()
  })

  it('leaves the command unchanged with no trust to pass, or no resume argv to find', async () => {
    expect((await launchWith('posix', resumeHome())).command).toBe(resumeCommand('posix'))
    expect((await launchWith('posix', resumeHome(POSIX_TRUST), 'my-codex')).command).toBe(
      'my-codex'
    )
  })

  it('reaches the sequenced startup command too, which the pane runs instead', async () => {
    const launch = await launchWith('posix', resumeHome(POSIX_TRUST))
    const env = rewriteSequencedStartupResumeArgv(
      { [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: resumeCommand('posix') },
      launch
    )
    expect(env[SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]).toBe(launch.command)
  })
})

describe("the pane shell's command dialect", () => {
  it('follows the Windows shell, and is portable Unix quoting everywhere else', () => {
    expect(resolveCodexResumeStartupShell('win32', undefined)).toBe('powershell')
    expect(resolveCodexResumeStartupShell('win32', 'C:\\Windows\\system32\\cmd.exe')).toBe('cmd')
    expect(resolveCodexResumeStartupShell('win32', 'git-bash')).toBe('posix')
    expect(resolveCodexResumeStartupShell('darwin', '/opt/homebrew/bin/fish')).toBe('posix')
    expect(resolveCodexResumeStartupShell('linux', undefined)).toBe('posix')
  })
})
