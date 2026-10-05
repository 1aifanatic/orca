import { describe, expect, it } from 'vitest'
import { applyExtraAgentArgs } from './agent-extra-args'
import type { AgentStartupPlanInputs } from './agent-startup-plan-inputs'
import type { TuiAgent } from './tui-agent'
import { tokenizeStartupCommand } from './tui-agent-startup-shell'

function inputs(
  agent: TuiAgent,
  agentArgs: string | null,
  overrides: Partial<AgentStartupPlanInputs> = {}
): AgentStartupPlanInputs {
  return {
    agent,
    cmdOverrides: {},
    agentArgs,
    agentEnv: {},
    platform: 'linux',
    shell: undefined,
    isRemote: false,
    sessionOptionsOverrideAgentArgs: false,
    ...overrides
  }
}

function merge(
  base: AgentStartupPlanInputs,
  extras: string,
  promptOnCommandLine = false
): ReturnType<typeof applyExtraAgentArgs> {
  return applyExtraAgentArgs(base, extras, { promptOnCommandLine })
}

function merged(base: AgentStartupPlanInputs, extras: string): string | null {
  const result = merge(base, extras)
  if (!result.ok) {
    throw new Error(result.error.message)
  }
  return result.inputs.agentArgs
}

function refusal(base: AgentStartupPlanInputs, extras: string, promptOnCommandLine = false) {
  const result = merge(base, extras, promptOnCommandLine)
  if (result.ok) {
    throw new Error(`expected a refusal, got ${result.inputs.agentArgs}`)
  }
  return { code: result.error.code, source: result.error.source, message: result.error.message }
}

describe('applyExtraAgentArgs', () => {
  it('returns the inputs unchanged without extras', () => {
    const base = inputs('claude', '--dangerously-skip-permissions')
    expect(merge(base, '   ')).toEqual({ ok: true, inputs: base, extraKind: null })
  })

  it('adds extras after the defaults', () => {
    expect(merged(inputs('claude', '--dangerously-skip-permissions'), '--model opus')).toBe(
      '--dangerously-skip-permissions --model opus'
    )
    expect(merged(inputs('claude', null), ' --model opus ')).toBe('--model opus')
  })

  it.each([
    ['claude', '--model sonnet --verbose', '--model=opus', '--verbose --model=opus'],
    ['claude', '--effort low', '--effort max', '--effort max'],
    [
      'codex',
      '-m o3 -c model_reasoning_effort=low -c x=1',
      '-c model_reasoning_effort=high',
      '-m o3 -c x=1 -c model_reasoning_effort=high'
    ],
    ['codex', '--model o3', '-mgpt-5.5', '-mgpt-5.5'],
    ['opencode', '-m a --agent b', '--model c', '--agent b --model c'],
    ['opencode2', '--model a', '-m c', '-m c'],
    ['amp', '--model a --x', '--model=b', '--x --model=b']
  ] satisfies [TuiAgent, string, string, string][])(
    'replaces the same option for %s',
    (agent, base, extras, expected) => {
      expect(merged(inputs(agent, base), extras)).toBe(expected)
    }
  )

  it('keeps the -m of another CLI out of the default singleton list', () => {
    expect(merged(inputs('claude', '-m x'), '--model y')).toBe('-m x --model y')
  })

  it('inserts extras before a base terminator', () => {
    expect(merged(inputs('claude', '--model a --verbose -- x y'), '--model b')).toBe(
      '--verbose --model b -- x y'
    )
  })

  it.each([
    ['posix', 'linux', "a --model a 'a b' -- a", "a 'a b' --model b -- a"],
    ['powershell', 'win32', "a --model a 'a b' -- a", "a 'a b' --model b -- a"],
    ['cmd', 'win32', 'a --model a "a b" -- a', 'a "a b" --model b -- a']
  ] as const)(
    'recovers spans when token values repeat on %s',
    (shell, platform, base, expected) => {
      expect(merged(inputs('claude', base, { platform, shell }), '--model b')).toBe(expected)
    }
  )

  it.each([
    ['powershell', '--add-dir x`'],
    ['cmd', '--add-dir x^']
  ] as const)('refuses %s extras ending in an escape before a base terminator', (shell, extras) => {
    const result = merge(inputs('claude', '-- y', { platform: 'win32', shell }), extras)
    expect(!result.ok && result.error.code).toMatch(/rebuild-failed|windows-token/)
  })

  it.each([
    ['posix', `--add-dir 'a b' --x "c d"`],
    ['powershell', "--add-dir 'a b' --x 'it''s'"],
    ['cmd', '--add-dir "a b" --x y']
  ] as const)('preserves the defaults quoting on %s', (shell, base) => {
    const platform = shell === 'posix' ? 'linux' : 'win32'
    const result = merged(inputs('claude', base, { platform, shell }), '--verbose')
    expect(result).toBe(`${base} --verbose`)
  })

  describe('verify step', () => {
    it.each([
      ['posix', 'linux', '--add-dir x\\', '--verbose'],
      ['powershell', 'win32', '--add-dir x`', '--verbose'],
      ['cmd', 'win32', '--add-dir x^', '--verbose']
    ] as const)('refuses a base ending in its escape on %s', (shell, platform, base, extras) => {
      expect(refusal(inputs('claude', base, { platform, shell }), extras).code).toMatch(
        /rebuild-failed|defaults-unclosed-quote|windows-token/
      )
    })

    it('refuses extras ending in an escape before a base terminator', () => {
      expect(refusal(inputs('claude', '-- x'), '--add-dir C:\\').code).toBe('rebuild-failed')
    })

    it('verifies the trimmed result for an escaped trailing space, as the launch reads it', () => {
      const result = merge(inputs('claude', null), '--add-dir my\\ ')
      const tokens = result.ok && tokenizeStartupCommand(result.inputs.agentArgs ?? '', 'posix')
      expect(tokens && tokens.ok && tokens.tokens).toEqual(['--add-dir', 'my\\'])
    })
  })

  describe('refusals', () => {
    it.each([
      ['extras', "--model 'opus", 'extras-unclosed-quote'],
      ['extras', '--model a -- b', 'extras-terminator'],
      ['extras', 'resume --last', 'extras-leading-bare-word'],
      ['extras', 'exec', 'extras-leading-bare-word']
    ])('refuses %s: %s', (source, extras, code) => {
      expect(refusal(inputs('codex', null), extras)).toMatchObject({ code, source })
    })

    it('keeps a bare word after a flag as its value', () => {
      expect(merged(inputs('claude', null), '--agent reviewer')).toBe('--agent reviewer')
    })

    it('reports an unclosed quote in the defaults', () => {
      expect(refusal(inputs('claude', "--x 'a"), '--verbose')).toMatchObject({
        code: 'defaults-unclosed-quote',
        source: 'defaults'
      })
    })

    it('reports an unclosed quote in the override only when a family flag is typed', () => {
      const base = inputs('claude', null, { cmdOverrides: { claude: "claude 'x" } })
      expect(merged(base, '--verbose')).toBe('--verbose')
      expect(refusal(base, '--model opus')).toMatchObject({
        code: 'override-unclosed-quote',
        source: 'override'
      })
    })

    it('refuses an override that sets a typed family, not another flag', () => {
      const base = inputs('claude', null, { cmdOverrides: { claude: 'claude --model sonnet' } })
      expect(refusal(base, '--model opus')).toMatchObject({
        code: 'override-sets-option',
        source: 'override'
      })
      expect(merged(base, '--effort high')).toBe('--effort high')
    })

    it('refuses a bypass flag only while the defaults have it', () => {
      const yolo = inputs('grok', '--permission-mode bypassPermissions')
      expect(refusal(yolo, '--permission-mode plan')).toMatchObject({
        code: 'defaults-set-flag',
        source: 'extras',
        message: expect.stringContaining('Your default arguments for Grok')
      })
      expect(merged(inputs('grok', ''), '--permission-mode plan')).toBe('--permission-mode plan')
    })

    it('names the defaults even when the user typed the bypass flag in Settings', () => {
      expect(
        refusal(inputs('qwen-code', '--approval-mode yolo'), '--approval-mode plan').code
      ).toBe('defaults-set-flag')
    })

    it('refuses a typed bypass flag the override carries', () => {
      const base = inputs('grok', '', {
        cmdOverrides: { grok: 'grok --permission-mode bypassPermissions' }
      })
      expect(refusal(base, '--permission-mode plan')).toMatchObject({
        code: 'override-sets-option',
        source: 'override'
      })
    })

    it('adds a repeatable bypass flag', () => {
      expect(merged(inputs('continue', '--allow "*"'), '--allow Write')).toBe(
        '--allow "*" --allow Write'
      )
    })

    it.each([
      ['claude', '--resume abc'],
      ['claude', '--resume=abc'],
      ['claude', '-r abc'],
      ['claude', '-c'],
      ['claude', '--fork-session'],
      ['claude', '--session-id x'],
      ['claude', '--from-pr 1'],
      ['claude', '--teleport'],
      ['claude', '--agent -review'],
      ['opencode', '-s abc'],
      ['grok', '-s 11111111-1111-4111-8111-111111111111'],
      ['grok', '-s=abc'],
      ['grok', '-sabc'],
      ['grok', '--load abc'],
      ['claude', '--cloud other-session'],
      ['omp', '--from-claude'],
      ['codex', '--search resume --last'],
      ['codex', '--search fork'],
      ['muse', '--x resume']
    ] as const)('refuses a session selector for %s: %s', (agent, extras) => {
      expect(refusal(inputs(agent, null), extras).code).toBe('session-selector')
    })

    it("doesn't take Codex's -c config flag or a joined dash value as a selector", () => {
      expect(merged(inputs('codex', null), '-c x=1')).toBe('-c x=1')
      expect(merged(inputs('claude', null), '--agent=-review')).toBe('--agent=-review')
    })

    it.each([
      ['claude', '--prefill x', '--prefill'],
      ['claude', '--prefill-b64 eA==', '--prefill'],
      ['opencode', '--prompt x', '--prompt'],
      ['gemini', '--prompt-interactive x', '--prompt-interactive'],
      ['gemini', '-i x', '--prompt-interactive'],
      ['gemini', '--prompt x', '--prompt-interactive'],
      ['gemini', '-p x', '--prompt-interactive'],
      ['antigravity', '-i x', '--prompt-interactive'],
      ['copilot', '--interactive x', '-i'],
      ['hermes', '--query-file f', '--query'],
      ['hermes', '--query-file=f', '--query'],
      ['copilot', '-i x', '-i'],
      ['hermes', '--query x', '--query'],
      ['hermes', '-q x', '--query'],
      ['hermes', '-q=x', '--query'],
      ['hermes', '-qx', '--query'],
      ['hermes', '--query=x', '--query'],
      ['hermes', '--que x', '--query'],
      ['hermes', '--query-f=f', '--query']
    ] as const)("refuses %s's prompt flag in %s", (agent, extras, flag) => {
      expect(refusal(inputs(agent, null), extras)).toMatchObject({
        code: 'prompt-flag',
        message: `Orca uses ${flag} to pass the prompt.`
      })
    })

    it("refuses grok's prompt flags only next to a positional prompt", () => {
      for (const extras of [
        '-p hi',
        '--single hi',
        '--print hi',
        '--prompt-file f',
        '--prompt-json {}'
      ]) {
        expect(refusal(inputs('grok', null), extras, true).code).toBe('competing-prompt')
        expect(merge(inputs('grok', null), extras).ok).toBe(true)
      }
    })

    it("doesn't take a short Hermes flag that isn't a prefix of Orca's", () => {
      expect(merged(inputs('hermes', null), '--model x --yolo')).toBe('--model x --yolo')
    })

    it("refuses Hermes's --cli only with a prompt, and never --tui", () => {
      expect(merged(inputs('hermes', null), '--cli')).toBe('--cli')
      expect(refusal(inputs('hermes', null), '--cli', true).code).toBe('hermes-cli')
      expect(merge(inputs('hermes', null), '--tui', true).ok).toBe(true)
    })

    it('refuses an argv agent without a separator only with a bare prompt', () => {
      expect(merged(inputs('claude', null), '--add-dir x')).toBe('--add-dir x')
      expect(refusal(inputs('claude', null), '--add-dir x', true)).toMatchObject({
        code: 'bare-prompt',
        message: expect.stringContaining('Claude')
      })
      expect(merge(inputs('grok', null), '--reasoning-effort high', true).ok).toBe(true)
    })

    it.each([
      ['--model a --model b', '-m'],
      ['-c model_reasoning_effort=a -c model_reasoning_effort=b', '-c model_reasoning_effort=…']
    ])('refuses a family typed twice: %s', (extras, option) => {
      expect(refusal(inputs('codex', null), extras)).toMatchObject({
        code: 'repeated-option',
        message: `${option} appears twice in the extra arguments.`
      })
    })

    it('refuses a bypass flag typed twice but not a repeatable flag', () => {
      expect(refusal(inputs('grok', ''), '--permission-mode a --permission-mode b').code).toBe(
        'repeated-option'
      )
      expect(merged(inputs('claude', null), '--add-dir a --add-dir b')).toBe(
        '--add-dir a --add-dir b'
      )
    })

    it('refuses defaults that are too large once the extras join them', () => {
      expect(refusal(inputs('claude', `--x ${'a'.repeat(16_380)}`), '--verbose').code).toBe(
        'too-large'
      )
    })

    it('passes an unknown flag typed and also in the defaults', () => {
      expect(merged(inputs('claude', '--add-dir a'), '--add-dir b')).toBe('--add-dir a --add-dir b')
    })

    it('refuses a flag the defaults set when Orca has no remover for it', () => {
      expect(refusal(inputs('grok', '--reasoning-effort low'), '--effort high')).toMatchObject({
        code: 'defaults-set-flag',
        message: expect.stringContaining('--reasoning-effort')
      })
    })

    it('refuses oversized extras quickly', () => {
      const started = performance.now()
      expect(refusal(inputs('claude', null), '--x '.repeat(6000)).code).toBe('too-large')
      expect(merge(inputs('claude', null), '--x '.repeat(4000)).ok).toBe(true)
      expect(performance.now() - started).toBeLessThan(150)
    })

    it('refuses a merged string over 16 KB in bytes', () => {
      expect(refusal(inputs('claude', null), `--x ${'é'.repeat(8200)}`).code).toBe('too-large')
      expect(merge(inputs('claude', null), `--x ${'a'.repeat(16_000)}`).ok).toBe(true)
    })
  })

  describe('Windows tokens', () => {
    it.each([
      ['cmd', '--x a&b', 'extras'],
      ['cmd', '--x a\\', 'extras'],
      ['powershell', '--x ""', 'extras'],
      ['powershell', `--x 'a"b'`, 'extras'],
      ['powershell', "--x 'a b\\'", 'extras']
    ] as const)('refuses %s token in %s', (shell, extras, source) => {
      expect(refusal(inputs('claude', null, { platform: 'win32', shell }), extras)).toMatchObject({
        code: 'windows-token',
        source
      })
    })

    it('refuses such a token in the defaults', () => {
      expect(
        refusal(inputs('claude', '--x a%b', { platform: 'win32', shell: 'cmd' }), '--verbose')
      ).toMatchObject({ code: 'windows-token', source: 'defaults' })
    })

    it('accepts them on POSIX', () => {
      expect(merged(inputs('claude', null), `--x 'a&b' --y '' --z 'a"b'`)).toBe(
        `--x 'a&b' --y '' --z 'a"b'`
      )
    })
  })

  describe('OMP fresh session', () => {
    it('refuses an extra the wrapper does not accept while the defaults keep it', () => {
      expect(refusal(inputs('omp', '--model a'), '--unknown x')).toMatchObject({
        code: 'omp-fresh-session',
        message: expect.stringContaining('--unknown')
      })
      expect(merged(inputs('omp', null), '--thinking high --config x.yml')).toBe(
        '--thinking high --config x.yml'
      )
    })

    it('accepts any extra when the defaults already turn the wrapper off', () => {
      expect(merged(inputs('omp', '--unknown y'), '--other z')).toBe('--unknown y --other z')
    })
  })

  describe('chat options', () => {
    it('drops every pick for a typed model when picks beat the defaults', () => {
      const result = merge(
        inputs('claude', null, {
          sessionOptions: { model: 'opus', effort: 'max' },
          sessionOptionsOverrideAgentArgs: true
        }),
        '--model sonnet'
      )
      expect(result.ok && result.inputs.sessionOptions).toBeUndefined()
    })

    it('drops only the effort pick for a typed effort', () => {
      const result = merge(
        inputs('claude', null, {
          sessionOptions: { model: 'opus', effort: 'max' },
          sessionOptionsOverrideAgentArgs: true
        }),
        '--effort low'
      )
      expect(result.ok && result.inputs.sessionOptions).toEqual({ model: 'opus' })
    })

    it('leaves picks alone when they do not beat the defaults', () => {
      const sessionOptions = { model: 'opus', effort: 'max' }
      const result = merge(inputs('claude', null, { sessionOptions }), '--effort low')
      expect(result.ok && result.inputs.sessionOptions).toEqual(sessionOptions)
    })
  })

  it.each([
    ['claude', '--model opus --effort max', 'catalog_only'],
    ['claude', '--model opus --verbose', 'other'],
    ['codex', '-m o3 -c model_reasoning_effort=high', 'catalog_only'],
    ['codex', '-c x=1', 'other'],
    ['claude', '--model opus stray', 'other'],
    ['aider', '--model x', 'other']
  ] as const)('classifies %s extras %s as %s', (agent, extras, kind) => {
    const result = merge(inputs(agent, null), extras)
    expect(result.ok && result.extraKind).toBe(kind)
  })
})
