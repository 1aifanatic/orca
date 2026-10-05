import { describe, expect, it } from 'vitest'
import {
  parseStructuredAgentCommandOverride,
  validateStructuredAgentCommandArgs
} from './tui-agent-launch-command-override'

describe('structured agent Command parsing', () => {
  it.each([undefined, '', '   '])('uses the default for %s', (value) => {
    expect(parseStructuredAgentCommandOverride(value, 'linux')).toBeNull()
  })
  it.each([
    ['ccr code', 'ccr', ['code']],
    ['npx @anthropic-ai/claude-code', 'npx', ['@anthropic-ai/claude-code']],
    ['"/tools with spaces/claude" --profile ""', '/tools with spaces/claude', ['--profile', '']],
    ["claude '--label=$HOME & *'", 'claude', ['--label=$HOME & *']],
    ['~/bin/my-claude', '~/bin/my-claude', []],
    ['claude --label escaped\\&literal', 'claude', ['--label', 'escaped&literal']]
  ] as const)('preserves literal argv in %s', (value, command, prefixArgs) => {
    expect(parseStructuredAgentCommandOverride(value, 'darwin')).toEqual({ command, prefixArgs })
  })
  it('preserves a quoted Windows executable and backslashes', () => {
    expect(
      parseStructuredAgentCommandOverride('"C:\\Agent Tools\\wrapper.cmd" code ""', 'win32')
    ).toEqual({
      command: 'C:\\Agent Tools\\wrapper.cmd',
      prefixArgs: ['code', '']
    })
  })
  it.each([
    'claude | cat',
    'claude && echo done',
    'claude > out',
    'claude; echo done',
    'KEY=value claude',
    'claude $FLAGS',
    'claude "${FLAGS}"',
    'claude $(echo x)',
    'claude `echo x`',
    'claude *.txt',
    'claude "unclosed',
    'claude\0',
    'claude\necho x'
  ])('rejects shell-only command %s', (command) => {
    expect(() => parseStructuredAgentCommandOverride(command, 'linux')).toThrow()
  })
  it.each(['claude %USERPROFILE%', 'claude $env:FLAGS', 'claude & other'])(
    'rejects Windows expansion %s',
    (command) => {
      expect(() => parseStructuredAgentCommandOverride(command, 'win32')).toThrow()
    }
  )
})

describe('structured command preference and transport ownership', () => {
  it.each([
    ['claude', ['--model=opus'], { model: 'opus' }],
    ['claude', ['--effort', 'high'], { effort: 'high' }],
    ['codex', ['-m', 'custom-model'], { model: 'custom-model' }],
    ['codex', ['-cmodel=custom-model'], { model: 'custom-model' }],
    ['codex', ['--config', 'model_reasoning_effort=high'], { effort: 'high' }],
    ['codex', ['--reasoning-effort=high'], { model: 'unknown-model', effort: 'high' }]
  ] as const)('rejects %s flags competing with a requested pick', (agent, args, options) => {
    expect(validateStructuredAgentCommandArgs(agent, args, options)).toBe('customCommandConflict')
  })
  it.each(['claude', 'codex'] as const)(
    'keeps %s model defaults without a competing pick',
    (agent) => {
      expect(validateStructuredAgentCommandArgs(agent, ['--model', 'custom'])).toBeUndefined()
    }
  )
  it.each([
    ['claude', ['--session-id=x']],
    ['claude', ['--input-format=text']],
    ['claude', ['--permission-mode=bypassPermissions']],
    ['codex', ['--listen=tcp://host']],
    ['codex', ['-c', 'sandbox_mode=disabled']],
    ['codex', ['--config=approval_policy=never']],
    ['codex', ['--cd', '/other']],
    ['claude', ['--settings', 'account.json']],
    ['codex', ['--']],
    ['claude', ['CLAUDE_CONFIG_DIR=/other']]
  ] as const)('rejects %s transport/account flags', (agent, args) => {
    expect(validateStructuredAgentCommandArgs(agent, args)).toBe('customCommandInvalid')
  })
  it('does not mistake a required option value for a model flag', () => {
    expect(
      validateStructuredAgentCommandArgs('claude', ['--append-system-prompt', '--model'], {
        model: 'opus'
      })
    ).toBeUndefined()
  })
})

it.each(['claude', 'codex'] as const)(
  'treats cleared %s picks as no requested preference',
  (agent) => {
    expect(
      validateStructuredAgentCommandArgs(agent, ['--model', 'custom'], { model: '', effort: '' })
    ).toBeUndefined()
  }
)
it('allows a required Claude option whose literal value is the terminator', () => {
  expect(
    validateStructuredAgentCommandArgs('claude', ['--append-system-prompt', '--'])
  ).toBeUndefined()
})
