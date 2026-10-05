import { describe, expect, it } from 'vitest'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'
import { tokenizeStartupCommand } from './tui-agent-startup-shell'

describe.each(['posix', 'powershell', 'cmd'] as const)('argument values on %s', (shell) => {
  function launch(agentArgs: string, sessionOptionsOverrideAgentArgs = false) {
    const result = resolveAgentLaunchCommand({
      agent: 'claude',
      cmdOverrides: {},
      platform: shell === 'posix' ? 'linux' : 'win32',
      shell,
      sessionOptions: { model: 'opus', effort: 'xhigh' },
      agentArgs,
      sessionOptionsOverrideAgentArgs
    })
    if (!result.ok) {
      throw new Error(result.error)
    }
    return { ...result, argv: tokenizeStartupCommand(result.command, shell) }
  }

  it.each(['--model=haiku', '--effort=low'])(
    'keeps picks when the system prompt is %s',
    (value) => {
      const result = launch(`--append-system-prompt "${value}"`)
      expect(result.argv).toMatchObject({
        ok: true,
        tokens: ['claude', '--model', 'opus', '--effort', 'xhigh', '--append-system-prompt', value]
      })
      expect(result.appliedSessionOptions).toEqual({ model: 'opus', effort: 'xhigh' })
    }
  )

  it('replaces real worker flags while preserving flag-like prompt text', () => {
    const result = launch(
      '--append-system-prompt "--model=haiku" --system-prompt "--effort=low" --model sonnet --effort low',
      true
    )
    expect(result.argv).toMatchObject({
      ok: true,
      tokens: [
        'claude',
        '--append-system-prompt',
        '--model=haiku',
        '--system-prompt',
        '--effort=low',
        '--model',
        'opus',
        '--effort',
        'xhigh'
      ]
    })
    expect(result.appliedSessionOptions).toEqual({ model: 'opus', effort: 'xhigh' })
  })

  it('recognizes a real model flag after a prompt whose value is --', () => {
    const result = launch('--append-system-prompt "--" --model haiku')
    expect(result.argv).toMatchObject({
      ok: true,
      tokens: ['claude', '--append-system-prompt', '--', '--model', 'haiku']
    })
    expect(result.appliedSessionOptions).toEqual({})
  })

  it('inserts worker picks after a -- prompt value and before the real terminator', () => {
    const result = launch('--append-system-prompt "--" --model haiku -- literal', true)
    expect(result.argv).toMatchObject({
      ok: true,
      tokens: [
        'claude',
        '--append-system-prompt',
        '--',
        '--model',
        'opus',
        '--effort',
        'xhigh',
        '--',
        'literal'
      ]
    })
    expect(result.appliedSessionOptions).toEqual({ model: 'opus', effort: 'xhigh' })
  })

  it('recognizes a real effort flag after flag-like prompt text', () => {
    const result = launch('--system-prompt "--effort=low" --effort max')
    expect(result.argv).toMatchObject({
      ok: true,
      tokens: ['claude', '--model', 'opus', '--system-prompt', '--effort=low', '--effort', 'max']
    })
    expect(result.appliedSessionOptions).toEqual({ model: 'opus' })
  })

  it.each(['-p', '-c', '--debug', '--resume', '--worktree'])(
    'recognizes a model flag after boolean or optional-valued %s',
    (flag) => {
      const result = launch(`${flag} --model haiku`)
      expect(result.argv).toMatchObject({ ok: true, tokens: ['claude', flag, '--model', 'haiku'] })
      expect(result.appliedSessionOptions).toEqual({})
    }
  )

  it('recognizes a model flag after an option with an inline value', () => {
    const result = launch('--append-system-prompt=literal --model haiku')
    expect(result.argv).toMatchObject({
      ok: true,
      tokens: ['claude', '--append-system-prompt=literal', '--model', 'haiku']
    })
    expect(result.appliedSessionOptions).toEqual({})
  })

  it('keeps the Cursor model when its API key starts with -m', () => {
    const result = resolveAgentLaunchCommand({
      agent: 'cursor',
      cmdOverrides: {},
      platform: shell === 'posix' ? 'linux' : 'win32',
      shell,
      sessionOptions: { model: 'auto' },
      agentArgs: '--api-key "-my-test-key"'
    })
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(tokenizeStartupCommand(result.command, shell)).toMatchObject({
      ok: true,
      tokens: ['cursor-agent', '--model', 'auto', '--api-key', '-my-test-key']
    })
    expect(result.appliedSessionOptions).toEqual({ model: 'auto' })
  })
})
