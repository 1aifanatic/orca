import { describe, expect, it } from 'vitest'
import { StructuredAgentArgumentsError } from '../../native-chat/structured-agent-arguments-error'
import { grokAgentArgv } from './grok-launch-args'

const argv = (configured: readonly string[], fullAccess = false): string[] =>
  grokAgentArgv({ fullAccess, configured })

describe('grokAgentArgv', () => {
  it('keeps the root options `grok agent` reads before `agent`, as typed', () => {
    expect(
      argv([
        '--debug',
        '--debug-file',
        '/tmp/grok.log',
        '--leader-socket=/tmp/leader.sock',
        '--disable-web-search',
        '--no-auto-update'
      ])
    ).toEqual([
      '--debug',
      '--debug-file',
      '/tmp/grok.log',
      '--leader-socket',
      '/tmp/leader.sock',
      '--disable-web-search',
      '--no-auto-update',
      'agent',
      'stdio'
    ])
  })

  // `grok agent` ignores the root model, effort and leader options; its own take them.
  it('moves model, effort and --no-leader to the agent options', () => {
    expect(argv(['-mgrok-4', '--effort', 'high', '--reasoning-effort=low', '--no-leader'])).toEqual(
      [
        'agent',
        '--model',
        'grok-4',
        '--reasoning-effort',
        'high',
        '--reasoning-effort',
        'low',
        '--no-leader',
        'stdio'
      ]
    )
    expect(argv(['--model=grok-4'], true)).toEqual([
      'agent',
      '--model',
      'grok-4',
      '--always-approve',
      'stdio'
    ])
  })

  it('drops permission, terminal-only and session options with their values', () => {
    expect(
      argv([
        '--permission-mode',
        'bypassPermissions',
        '--always-approve',
        '--yolo',
        '--dangerously-skip-permissions',
        '--allow',
        'Bash(git:*)',
        '--allowedTools=Edit',
        '--deny',
        'Bash(rm:*)',
        '--disallowedTools',
        'Write',
        '--sandbox',
        'strict',
        '--trust',
        '--no-alt-screen',
        '--minimal',
        '--fullscreen',
        '-h',
        '-V',
        '--resume',
        'abc',
        '-r',
        '-c',
        '--session-id=s1',
        '-s',
        's2',
        '--fork-session',
        '--load',
        's3',
        '-p',
        'hello',
        '--output-format',
        'json',
        '--verbatim'
      ])
    ).toEqual(['agent', 'stdio'])
  })

  it.each([
    { configured: ['fix the private tests'], option: 'prompt', problem: 'positionalPrompt' },
    { configured: ['--debug', '--', 'private'], option: 'prompt', problem: 'positionalPrompt' },
    { configured: ['-'], option: 'prompt', problem: 'positionalPrompt' },
    { configured: ['--cwd', '/private'], option: '--cwd', problem: 'unsupportedOption' },
    { configured: ['-w'], option: '-w', problem: 'unsupportedOption' },
    { configured: ['--worktree=private'], option: '--worktree', problem: 'unsupportedOption' },
    { configured: ['--ref', 'private'], option: '--ref', problem: 'unsupportedOption' },
    { configured: ['--leader'], option: '--leader', problem: 'unsupportedOption' },
    { configured: ['--rules', 'private'], option: '--rules', problem: 'unsupportedOption' },
    {
      configured: ['--system-prompt', 'private'],
      option: '--system-prompt',
      problem: 'unsupportedOption'
    },
    { configured: ['--tools', 'private'], option: '--tools', problem: 'unsupportedOption' },
    { configured: ['--future=private'], option: '--future', problem: 'unsupportedOption' },
    { configured: ['--debug=private'], option: '--debug', problem: 'unsupportedOption' },
    { configured: ['-m', 'a', '--model', 'private'], option: '--model', problem: 'multipleValues' },
    { configured: ['-m'], option: '-m', problem: 'missingValue' },
    { configured: ['--debug-file', '--debug'], option: '--debug-file', problem: 'missingValue' }
  ] as const)('refuses what a chat cannot honor: %j', ({ configured, option, problem }) => {
    const thrown = () => argv(configured)
    expect(thrown).toThrow(StructuredAgentArgumentsError)
    try {
      thrown()
    } catch (error) {
      expect(error).toMatchObject({ argumentProblem: { agent: 'Grok', option, problem } })
      for (const text of [JSON.stringify(error), String(error)]) {
        expect(text).not.toContain('private')
      }
    }
  })
})
