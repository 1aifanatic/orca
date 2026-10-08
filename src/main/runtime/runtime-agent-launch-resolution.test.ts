import { describe, expect, it } from 'vitest'
import {
  resolveAgentLaunchCommandIdentity,
  resolveBareAgentLaunchCommand
} from './runtime-agent-launch-resolution'

type Settings = Parameters<typeof resolveAgentLaunchCommandIdentity>[0]['settings']

function identity(
  command: string | undefined,
  options: { settings?: Settings; platform?: NodeJS.Platform; isRemote?: boolean } = {}
) {
  return resolveAgentLaunchCommandIdentity({
    command,
    settings: options.settings ?? {},
    platform: options.platform ?? 'darwin',
    isRemote: options.isRemote ?? false
  })
}

describe('resolveAgentLaunchCommandIdentity', () => {
  it.each([
    ['omp', 'omp'],
    ['omp --thinking high', 'omp'],
    ['codex -c model_reasoning_effort="high"', 'codex'],
    ['OMP_DEBUG=1 FOO=bar omp --thinking high', 'omp'],
    ['/usr/local/bin/omp --thinking high', 'omp'],
    ['"C:\\Program Files\\Agents\\codex.exe" --full-auto', 'codex'],
    ['C:\\Users\\me\\AppData\\Roaming\\agents\\codex.cmd -m gpt-5', 'codex'],
    ['claude --model opus', 'claude'],
    ['orca claude-teams --teammate-mode auto', 'claude-agent-teams']
  ])('names the agent in %s', (command, agent) => {
    expect(identity(command)).toBe(agent)
  })

  it.each([
    [undefined],
    [''],
    ['   '],
    ['notes-editor README.md'],
    ['log-pager -R log.txt'],
    ['FOO=1 site-builder test'],
    // Headless one-shots never open a composer.
    ['claude -p "summarize"'],
    ['orca terminal list']
  ])('names no agent in %s', (command) => {
    expect(identity(command)).toBeNull()
  })

  it('keeps the exact launch match the startup plan uses', () => {
    expect(identity('omp')).toBe(
      resolveBareAgentLaunchCommand({
        command: 'omp',
        settings: {},
        platform: 'darwin',
        isRemote: false
      })
    )
    // The flagged command names OMP for readiness but stays outside the startup plan.
    expect(
      resolveBareAgentLaunchCommand({
        command: 'omp --thinking high',
        settings: {},
        platform: 'darwin',
        isRemote: false
      })
    ).toBeNull()
  })

  it('matches a user override by its command words, flags aside', () => {
    const settings: Settings = {
      agentCmdOverrides: {
        claude: 'agent-router code --dangerously-skip-permissions',
        codex: 'pkg-runner codex-wrap'
      }
    }
    expect(identity('agent-router code --resume', { settings })).toBe('claude')
    expect(identity('pkg-runner codex-wrap -m gpt-5', { settings })).toBe('codex')
    // An override's launcher alone must not claim every command run through it.
    expect(identity('pkg-runner formatter --write .', { settings })).toBeNull()
    expect(identity('agent-router status', { settings })).toBeNull()
  })

  it('names no disabled agent, through its default command or its override', () => {
    const settings: Settings = {
      disabledTuiAgents: ['omp', 'claude'],
      agentCmdOverrides: { claude: 'my-claude' }
    }
    expect(identity('omp --thinking high', { settings })).toBeNull()
    expect(identity('my-claude --model opus', { settings })).toBeNull()
    expect(identity('codex --full-auto', { settings })).toBe('codex')
  })

  it('resolves on remote and Windows hosts', () => {
    expect(identity('orca claude-teams --x', { platform: 'linux', isRemote: true })).toBe(
      'claude-agent-teams'
    )
    expect(identity('codex.exe --full-auto', { platform: 'win32' })).toBe('codex')
    expect(identity('omp.cmd --thinking high', { platform: 'win32', isRemote: true })).toBe('omp')
    // WSL launches resolve as Linux.
    expect(identity('FOO=1 /home/me/.local/bin/omp --thinking high', { platform: 'linux' })).toBe(
      'omp'
    )
  })
})
