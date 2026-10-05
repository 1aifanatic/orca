import { describe, expect, it } from 'vitest'
import { applyExtraAgentArgs } from './agent-extra-args'
import type { AgentStartupPlanInputs } from './agent-startup-plan-inputs'
import { resolveAgentLaunchFinalArgs } from './agent-launch-final-args'

function inputs(overrides: Partial<AgentStartupPlanInputs> = {}): AgentStartupPlanInputs {
  return {
    agent: 'claude',
    agentArgs: null,
    cmdOverrides: {},
    agentEnv: {},
    platform: 'linux',
    shell: 'posix',
    isRemote: false,
    sessionOptionsOverrideAgentArgs: false,
    ...overrides
  }
}

describe.each(['posix', 'powershell', 'cmd'] as const)('extra argument values on %s', (shell) => {
  function merge(extras: string, overrides: Partial<AgentStartupPlanInputs> = {}) {
    return applyExtraAgentArgs(
      inputs({ platform: shell === 'posix' ? 'linux' : 'win32', shell, ...overrides }),
      extras,
      { promptOnCommandLine: false }
    )
  }

  it.each(['--resume', '--prefill', '--model=haiku', '--dangerously-skip-permissions', '--'])(
    'preserves %s as a system-prompt value',
    (value) => {
      const merged = merge(`--system-prompt "${value}" --model opus`)
      expect(merged.ok && resolveAgentLaunchFinalArgs(merged.inputs, { prompt: '' })).toEqual({
        ok: true,
        args: ['--system-prompt', value, '--model', 'opus']
      })
    }
  )

  it('inserts before the real terminator after a -- value', () => {
    const merged = merge('--effort high', { agentArgs: '--system-prompt "--" -- literal' })
    expect(merged.ok && resolveAgentLaunchFinalArgs(merged.inputs, { prompt: '' })).toEqual({
      ok: true,
      args: ['--system-prompt', '--', '--effort', 'high', '--', 'literal']
    })
  })

  it('preserves defaults and overrides containing flag-looking values', () => {
    const merged = merge('--model opus --dangerously-skip-permissions', {
      agentArgs: '--system-prompt "--dangerously-skip-permissions"',
      cmdOverrides: { claude: 'claude --system-prompt "--model=haiku"' }
    })
    expect(merged.ok).toBe(true)
  })

  it('finds a real duplicate after a flag-looking value', () => {
    const merged = merge('--model opus --system-prompt "--model=haiku" --model sonnet')
    expect(!merged.ok && merged.error.code).toBe('repeated-option')
  })

  it('ignores a flag-looking value after the first option', () => {
    expect(merge('--model opus --system-prompt "--model=haiku"').ok).toBe(true)
  })

  it('validates only defaults that survive replacement', () => {
    expect(merge('--model opus', { agentArgs: '--model ""' }).ok).toBe(true)
  })

  it('replaces an abbreviated Hermes model flag', () => {
    const merged = merge('--mo new', { agent: 'hermes', agentArgs: '--model old' })
    expect(merged.ok && resolveAgentLaunchFinalArgs(merged.inputs, { prompt: '' })).toEqual({
      ok: true,
      args: ['--mo', 'new']
    })
  })

  it('finds duplicate Hermes options through their abbreviated forms', () => {
    const merged = merge('--model old --mo new', { agent: 'hermes' })
    expect(!merged.ok && merged.error.code).toBe('repeated-option')
  })
})
