import { describe, expect, it } from 'vitest'
import { applyExtraAgentArgs } from './agent-extra-args'
import { resolveAgentLaunchFinalArgs } from './agent-launch-final-args'
import type { AgentStartupPlanInputs } from './agent-startup-plan-inputs'
import { resolveHermesStartupQuery } from './hermes-startup-query'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'
import { buildAgentStartupPlan } from './tui-agent-startup'
import { quoteStartupArg } from './tui-agent-startup-shell'

function inputs(overrides: Partial<AgentStartupPlanInputs>): AgentStartupPlanInputs {
  return {
    agent: 'claude',
    cmdOverrides: {},
    agentArgs: null,
    agentEnv: {},
    platform: 'linux',
    shell: undefined,
    isRemote: false,
    sessionOptionsOverrideAgentArgs: false,
    ...overrides
  }
}

describe('resolveAgentLaunchCommand args', () => {
  it.each([
    [{ sessionOptions: { model: 'opus' }, agentArgs: '--add-dir "a b" -- x' }],
    [
      {
        sessionOptions: { model: 'opus' },
        sessionOptionsOverrideAgentArgs: true,
        agentArgs: '--model haiku --add-dir a -- x'
      }
    ],
    [{ agentArgs: '--dangerously-skip-permissions' }],
    [{}]
  ])('match the built command', (overrides) => {
    for (const shell of ['posix', 'powershell', 'cmd'] as const) {
      const result = resolveAgentLaunchCommand({ ...inputs(overrides), shell })
      if (!result.ok) {
        throw new Error(result.error)
      }
      const quoted = result.args.map((arg) => quoteStartupArg(arg, shell)).join(' ')
      expect(result.command).toBe(quoted ? `claude ${quoted}` : 'claude')
    }
  })

  it('match the built command with a pick-precedence override', () => {
    const result = resolveAgentLaunchCommand({
      ...inputs({ sessionOptions: { model: 'opus' }, sessionOptionsOverrideAgentArgs: true }),
      cmdOverrides: { claude: 'npx claude' },
      shell: 'posix'
    })
    expect(result.ok && result.args).toEqual(['--model', 'opus'])
  })
})

describe('resolveAgentLaunchFinalArgs', () => {
  it('leaves out base flags a chat pick removes', () => {
    expect(
      resolveAgentLaunchFinalArgs(
        inputs({
          agentArgs: '--model haiku --verbose',
          sessionOptions: { model: 'opus', effort: 'max' },
          sessionOptionsOverrideAgentArgs: true
        }),
        { prompt: '' }
      )
    ).toEqual({ ok: true, args: ['--verbose', '--model', 'opus', '--effort', 'max'] })
  })

  it("shows the arguments Hermes's query mode keeps", () => {
    expect(
      resolveAgentLaunchFinalArgs(
        inputs({ agent: 'hermes', agentArgs: '--yolo --cli -q old --model x' }),
        { prompt: 'do it' }
      )
    ).toEqual({ ok: true, args: ['--yolo', '--model', 'x'] })
  })

  it.each([
    [{}, 'x'.repeat(30_000), 'hermes-too-large', 'extras'],
    [{ cmdOverrides: { hermes: 'my-wrapper --tui' } }, 'x', 'hermes-no-executable', 'override'],
    [
      {
        cmdOverrides: { hermes: 'A=1 hermes' },
        platform: 'win32' as const,
        shell: 'powershell' as const
      },
      'x',
      'hermes-env-assignments',
      'override'
    ],
    [{ agentArgs: "--x 'y" }, 'x', 'defaults-unclosed-quote', 'defaults']
  ])('reports why Hermes query mode cannot start: %j', (overrides, prompt, code, source) => {
    const result = resolveAgentLaunchFinalArgs(inputs({ agent: 'hermes', ...overrides }), {
      prompt
    })
    expect(!result.ok && { code: result.error.code, source: result.error.source }).toEqual({
      code,
      source
    })
  })

  it('shows an unknown flag from the defaults and the extras twice', () => {
    const merged = applyExtraAgentArgs(inputs({ agentArgs: '--add-dir a' }), '--add-dir b', {
      promptOnCommandLine: false
    })
    expect(merged.ok && resolveAgentLaunchFinalArgs(merged.inputs, { prompt: '' })).toEqual({
      ok: true,
      args: ['--add-dir', 'a', '--add-dir', 'b']
    })
  })

  it('keeps only the typed flag after pick-precedence settlement', () => {
    const merged = applyExtraAgentArgs(
      inputs({
        agentArgs: '--model haiku',
        sessionOptions: { model: 'opus', effort: 'max' },
        sessionOptionsOverrideAgentArgs: true
      }),
      '--effort low',
      { promptOnCommandLine: false }
    )
    expect(merged.ok && resolveAgentLaunchFinalArgs(merged.inputs, { prompt: '' })).toEqual({
      ok: true,
      args: ['--effort', 'low', '--model', 'opus']
    })
  })

  it('puts the separator between extras and the prompt for a separator agent', () => {
    const merged = applyExtraAgentArgs(inputs({ agent: 'grok' }), '--reasoning-effort high', {
      promptOnCommandLine: true
    })
    const plan =
      merged.ok &&
      buildAgentStartupPlan({ ...merged.inputs, prompt: 'hello', allowEmptyPromptLaunch: true })
    expect(plan && plan.launchCommand).toBe("grok '--reasoning-effort' 'high' -- 'hello'")
  })

  it("reports the launch's own error", () => {
    const result = resolveAgentLaunchFinalArgs(inputs({ agentArgs: "--x 'a" }), { prompt: '' })
    expect(!result.ok && result.error.message).toContain('CLI arguments are invalid')
  })
})

describe('resolveHermesStartupQuery', () => {
  it.each([
    [{ baseCommand: "hermes 'x" }, 'unparseable-command'],
    [{ agentArgs: "--x 'y" }, 'unparseable-agent-args'],
    [{ baseCommand: 'other --tui' }, 'no-hermes-executable'],
    [{ baseCommand: 'A=1 hermes', shell: 'powershell' as const }, 'env-assignments-need-posix']
  ])('names the cause for %j', (overrides, cause) => {
    expect(
      resolveHermesStartupQuery({
        baseCommand: 'hermes --tui',
        prompt: 'x',
        platform: 'linux',
        shell: 'posix',
        ...overrides
      })
    ).toEqual({ ok: false, cause })
  })
})
