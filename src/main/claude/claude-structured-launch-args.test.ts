import { describe, expect, it } from 'vitest'
import {
  claudeSavedOptionRejection,
  claudeStructuredLaunchArgs
} from './claude-structured-launch-args'
import {
  argumentProblemOf,
  StructuredAgentArgumentsError
} from '../native-chat/structured-agent-arguments-error'

const tokensOf = (args: readonly string[]): string[] =>
  claudeStructuredLaunchArgs(args).flatMap((arg) => arg.tokens)

describe('Claude structured launch arguments', () => {
  it('forwards options as typed, with every value and repeat', () => {
    const args = [
      '--effort=high',
      '--chrome',
      '--mcp-config',
      'a.json',
      'b.json',
      '--plugin-dir',
      '/one',
      '--plugin-dir',
      '/two',
      '--tools',
      'Bash',
      'Edit',
      '--add-dir',
      '/repo/other',
      '-n',
      'review',
      '--setting-sources=user'
    ]
    expect(tokensOf(args)).toEqual(args)
    expect(claudeStructuredLaunchArgs(['--add-dir', '/a', '/b', '-nreview'])).toEqual([
      { option: '--add-dir', tokens: ['--add-dir', '/a', '/b'] },
      { option: '--name', tokens: ['-nreview'] }
    ])
  })

  // The CLI's parser takes the next token as a required value whatever it starts with.
  it('keeps a dash-leading value of a required option, system prompts included', () => {
    const args = [
      '--append-system-prompt',
      '- Always answer in French',
      '--system-prompt-file',
      'prompt.md',
      '--append-system-prompt-file=extra.md'
    ]
    expect(tokensOf(args)).toEqual(args)
  })

  // The CLI is the authority on its own options; one it rejects is named as the saved option.
  it('forwards an unknown option and its bare words as typed', () => {
    expect(tokensOf(['-m', 'opus', '--future-flag', 'a', 'b', '--chrome'])).toEqual([
      '-m',
      'opus',
      '--future-flag',
      'a',
      'b',
      '--chrome'
    ])
  })

  it('drops the stream protocol, session identity and permission bypass with their values', () => {
    expect(
      tokensOf([
        '-p',
        '--input-format',
        'text',
        '--output-format=json',
        '--json-schema',
        '{}',
        '--verbose',
        '-r',
        'other-session',
        '-c',
        '--from-pr',
        '--session-id=other-session',
        '--fork-session',
        '--dangerously-skip-permissions',
        '--allow-dangerously-skip-permissions',
        '--permission-prompt-tool',
        'other',
        '--replay-user-messages',
        '--include-partial-messages',
        '-h',
        '--version',
        '-pc',
        '--model',
        'opus'
      ])
    ).toEqual(['--model', 'opus'])
  })

  // Agent Permissions owns the mode; tool rules pass. One switch each in the launch arguments.
  it('drops a typed permission mode and forwards tool rules under both spellings', () => {
    expect(
      tokensOf([
        '--permission-mode',
        'plan',
        '--inherit-permission-mode=acceptEdits',
        '--allowedTools',
        'Bash(git:*)',
        'Edit',
        '--disallowed-tools',
        'Bash(rm:*)'
      ])
    ).toEqual(['--allowedTools', 'Bash(git:*)', 'Edit', '--disallowed-tools', 'Bash(rm:*)'])
  })

  // Every option of the CLI's own table is read with its arity, hidden ones included.
  it('reads the values of options the CLI hides, dash-leading ones too', () => {
    const args = [
      '--append-subagent-system-prompt',
      '-v always',
      '--restricted',
      '--max-turns',
      '3',
      '-d2e'
    ]
    expect(tokensOf(args)).toEqual(args)
    expect(() => tokensOf(['--restricted', 'review this'])).toThrow(
      expect.objectContaining({ argumentProblem: expect.objectContaining({ option: 'prompt' }) })
    )
  })

  it('drops a bare trailing --', () => {
    expect(tokensOf(['--chrome', '--'])).toEqual(['--chrome'])
  })

  it.each([
    { args: ['fix the private tests'], option: 'prompt', problem: 'positionalPrompt' },
    { args: ['--chrome', 'private words'], option: 'prompt', problem: 'positionalPrompt' },
    { args: ['--', 'private words'], option: 'prompt', problem: 'positionalPrompt' },
    { args: ['-'], option: 'prompt', problem: 'positionalPrompt' },
    { args: ['--worktree', 'private'], option: '--worktree', problem: 'unsupportedOption' },
    { args: ['-w'], option: '-w', problem: 'unsupportedOption' },
    { args: ['--bg'], option: '--bg', problem: 'unsupportedOption' },
    { args: ['--cloud=private'], option: '--cloud', problem: 'unsupportedOption' },
    { args: ['--teleport'], option: '--teleport', problem: 'unsupportedOption' },
    { args: ['--remote-control'], option: '--remote-control', problem: 'unsupportedOption' },
    { args: ['--tmux'], option: '--tmux', problem: 'unsupportedOption' },
    { args: ['--environment', 'private'], option: '--environment', problem: 'unsupportedOption' },
    { args: ['--pool=private'], option: '--pool', problem: 'unsupportedOption' },
    { args: ['--append-system-prompt'], option: '--append-system-prompt', problem: 'missingValue' },
    { args: ['--add-dir'], option: '--add-dir', problem: 'missingValue' },
    { args: ['-n'], option: '-n', problem: 'missingValue' }
  ] as const)('refuses what a chat cannot honor: %j', ({ args, option, problem }) => {
    const thrown = () => claudeStructuredLaunchArgs(args)
    expect(thrown).toThrow(StructuredAgentArgumentsError)
    try {
      thrown()
    } catch (error) {
      expect(error).toMatchObject({ argumentProblem: { agent: 'Claude', option, problem } })
      expect(String(error)).not.toContain('private')
    }
  })

  // The CLI's own refusal of a saved option, named so the chat says which one to remove.
  it('names a saved option the CLI rejected at start', () => {
    const configured = claudeStructuredLaunchArgs(['--chrome', '--modle=opus', '-x'])
    const exited = (option: string) =>
      new Error(`claude stream-json exited (code 1): error: unknown option '${option}'`)

    for (const [rejected, option] of [
      ['--modle=opus', '--modle'],
      ['-x', '-x']
    ] as const) {
      const named = claudeSavedOptionRejection(exited(rejected), configured)
      expect(argumentProblemOf(named)).toEqual({
        agent: 'Claude',
        option,
        problem: 'unsupportedOption'
      })
      expect(named.cause).toBeInstanceOf(Error)
    }
    // Only the CLI's exact refusal of an option the user saved; anything else stays as it was.
    const other = exited('--thinking-display')
    expect(claudeSavedOptionRejection(other, configured)).toBe(other)
    const crash = new Error('claude stream-json exited (code 1): boom')
    expect(claudeSavedOptionRejection(crash, configured)).toBe(crash)
  })
})
