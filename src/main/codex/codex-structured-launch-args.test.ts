import { describe, expect, it } from 'vitest'
import { codexStructuredLaunchArgs } from './codex-structured-launch-args'
import { StructuredAgentArgumentsError } from '../native-chat/structured-agent-arguments-error'

describe('codexStructuredLaunchArgs', () => {
  it('passes config, feature and strict-config options in order', () => {
    expect(
      codexStructuredLaunchArgs([
        '-c',
        'model_reasoning_effort=high',
        '--enable',
        'unified_exec',
        '--config=web_search="cached"',
        '--disable=some_feature',
        '-c=model_provider=azure',
        '--strict-config'
      ])
    ).toEqual([
      '-c',
      'model_reasoning_effort=high',
      '--enable',
      'unified_exec',
      '--config',
      'web_search="cached"',
      '--disable',
      'some_feature',
      '-c',
      'model_provider=azure',
      '--strict-config'
    ])
  })

  // app-server ignores `-m` and `--search`; Codex's own equivalents are config it applies after `-c`.
  it('turns -m and --search into the config Codex derives from them, after the user config', () => {
    expect(
      codexStructuredLaunchArgs(['-m', 'gpt-5.6 "sol"', '--search', '-c', 'model="other"'])
    ).toEqual(['-c', 'model="other"', '-c', 'model="gpt-5.6 \\"sol\\""', '-c', 'web_search="live"'])
    expect(codexStructuredLaunchArgs(['--model=gpt-5.6-sol'])).toEqual([
      '-c',
      'model="gpt-5.6-sol"'
    ])
  })

  // Agent Permissions owns the posture, so neither the options nor their config keys reach Codex.
  it('drops permission options and the config that sets permissions', () => {
    expect(
      codexStructuredLaunchArgs([
        '-s',
        'read-only',
        '--sandbox=bogus',
        '-a',
        'untrusted',
        '--ask-for-approval=on-failure',
        '--approve-for-me',
        '--not-so-yolo',
        '-c',
        'approval_policy="never"',
        '--config',
        'sandbox_mode=danger-full-access',
        '-c',
        'approvals_reviewer="auto_review"',
        '-c',
        'sandbox_workspace_write.network_access=true',
        '-c',
        '"approval_policy" = "never"',
        '-c',
        'model_reasoning_effort=high'
      ])
    ).toEqual(['-c', 'model_reasoning_effort=high'])
  })

  it('still needs a value for a dropped permission option', () => {
    expect(() => codexStructuredLaunchArgs(['-s'])).toThrow(StructuredAgentArgumentsError)
    expect(() => codexStructuredLaunchArgs(['-a', '--search'])).toThrow(
      expect.objectContaining({
        argumentProblem: { agent: 'Codex', option: '-a', problem: 'missingValue' }
      })
    )
  })

  it('drops the bypass flag and terminal-only display options', () => {
    expect(
      codexStructuredLaunchArgs([
        '--dangerously-bypass-approvals-and-sandbox',
        '--yolo',
        '--no-alt-screen',
        '--no-daemon',
        '-h',
        '--version',
        '--'
      ])
    ).toEqual([])
  })

  it.each([
    { tokens: ['a private prompt'], option: 'prompt', problem: 'positionalPrompt' },
    { tokens: ['app-server'], option: 'prompt', problem: 'positionalPrompt' },
    { tokens: ['-'], option: 'prompt', problem: 'positionalPrompt' },
    { tokens: ['--', 'a private prompt'], option: 'prompt', problem: 'positionalPrompt' },
    { tokens: ['--profile', 'private'], option: '--profile', problem: 'unsupportedOption' },
    { tokens: ['-pprivate'], option: '-p', problem: 'unsupportedOption' },
    { tokens: ['--oss'], option: '--oss', problem: 'unsupportedOption' },
    {
      tokens: ['--local-provider', 'private'],
      option: '--local-provider',
      problem: 'unsupportedOption'
    },
    { tokens: ['--add-dir', '/private'], option: '--add-dir', problem: 'unsupportedOption' },
    { tokens: ['-C', '/private'], option: '-C', problem: 'unsupportedOption' },
    { tokens: ['--image=private.png'], option: '--image', problem: 'unsupportedOption' },
    { tokens: ['--worktree'], option: '--worktree', problem: 'unsupportedOption' },
    {
      tokens: ['--dangerously-bypass-hook-trust'],
      option: '--dangerously-bypass-hook-trust',
      problem: 'unsupportedOption'
    },
    {
      tokens: ['--remote', 'wss://private-host'],
      option: '--remote',
      problem: 'unsupportedOption'
    },
    { tokens: ['--remote=wss://private-host'], option: '--remote', problem: 'unsupportedOption' },
    {
      tokens: ['--remote-auth-token-env', 'PRIVATE_TOKEN'],
      option: '--remote-auth-token-env',
      problem: 'unsupportedOption'
    },
    { tokens: ['--unknown-flag=secret'], option: '--unknown-flag', problem: 'unsupportedOption' },
    { tokens: ['--search=secret'], option: '--search', problem: 'unsupportedOption' },
    { tokens: ['--enable'], option: '--enable', problem: 'missingValue' },
    { tokens: ['-m', '--secret'], option: '-m', problem: 'missingValue' }
  ] as const)('refuses what a chat cannot honor: %j', ({ tokens, option, problem }) => {
    const thrown = () => codexStructuredLaunchArgs(tokens)
    expect(thrown).toThrow(StructuredAgentArgumentsError)
    try {
      thrown()
    } catch (error) {
      expect(error).toMatchObject({
        argumentProblem: { agent: 'Codex', option, problem }
      })
      for (const text of [JSON.stringify(error), String(error)]) {
        expect(text).not.toContain('secret')
        expect(text).not.toContain('private')
      }
    }
  })
})
