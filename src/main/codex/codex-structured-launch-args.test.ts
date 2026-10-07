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
    ).toEqual({
      args: [
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
      ],
      permissions: {}
    })
  })

  // app-server ignores `-m` and `--search`; Codex's own equivalents are config it applies after `-c`.
  it('turns -m and --search into the config Codex derives from them, after the user config', () => {
    expect(
      codexStructuredLaunchArgs(['-m', 'gpt-5.6 "sol"', '--search', '-c', 'model="other"']).args
    ).toEqual(['-c', 'model="other"', '-c', 'model="gpt-5.6 \\"sol\\""', '-c', 'web_search="live"'])
    expect(codexStructuredLaunchArgs(['--model=gpt-5.6-sol']).args).toEqual([
      '-c',
      'model="gpt-5.6-sol"'
    ])
  })

  it('passes sandbox details and the reviewer, and reads the reviewer for the thread', () => {
    expect(
      codexStructuredLaunchArgs([
        '-c',
        'sandbox_workspace_write.network_access=true',
        '-c',
        'approvals_reviewer="auto_review"'
      ])
    ).toEqual({
      args: [
        '-c',
        'sandbox_workspace_write.network_access=true',
        '-c',
        'approvals_reviewer="auto_review"'
      ],
      permissions: { approvalsReviewer: 'auto_review' }
    })
  })

  it("reads on-failure as Codex's own on-request alias", () => {
    expect(codexStructuredLaunchArgs(['-a', 'on-failure']).permissions).toEqual({
      approvalPolicy: 'on-request'
    })
    expect(codexStructuredLaunchArgs(['-c', 'approval_policy="on-failure"']).permissions).toEqual({
      approvalPolicy: 'on-request'
    })
  })

  // Codex before 0.124 takes only `guardian_subagent` on the thread; later versions take either.
  it('keeps the reviewer as spelled', () => {
    for (const reviewer of ['user', 'auto_review', 'guardian_subagent'] as const) {
      expect(
        codexStructuredLaunchArgs(['-c', `approvals_reviewer="${reviewer}"`]).permissions
      ).toEqual({ approvalsReviewer: reviewer })
    }
  })

  it('reads the sandbox and approval the Arguments state, flags over config', () => {
    expect(codexStructuredLaunchArgs(['-s', 'read-only', '-a', 'untrusted'])).toEqual({
      args: [],
      permissions: { sandbox: 'read-only', approvalPolicy: 'untrusted' }
    })
    expect(
      codexStructuredLaunchArgs([
        '-c',
        'sandbox_mode="danger-full-access"',
        '--config',
        "approval_policy='never'",
        '-c',
        'sandbox_mode=read-only'
      ]).permissions
    ).toEqual({ sandbox: 'read-only', approvalPolicy: 'never' })
    expect(
      codexStructuredLaunchArgs(['--sandbox=workspace-write', '-c', 'sandbox_mode=read-only'])
        .permissions
    ).toEqual({ sandbox: 'workspace-write' })
  })

  it('applies --approve-for-me as the config Codex folds it into', () => {
    expect(codexStructuredLaunchArgs(['--approve-for-me', '-c', 'approval_policy=never'])).toEqual({
      args: [
        '-c',
        'approval_policy=never',
        '-c',
        'approvals_reviewer="auto_review"',
        '-c',
        'approval_policy="on-request"',
        '-c',
        'sandbox_mode="workspace-write"'
      ],
      permissions: {
        approvalsReviewer: 'auto_review',
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write'
      }
    })
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
    ).toEqual({ args: [], permissions: {} })
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
    { tokens: ['-m', '--secret'], option: '-m', problem: 'missingValue' },
    // An invalid value names the setting it is for, however the Arguments spelled it.
    { tokens: ['-s', 'private-mode'], option: 'sandbox_mode', problem: 'invalidValue' },
    {
      tokens: ['--ask-for-approval=private'],
      option: 'approval_policy',
      problem: 'invalidValue'
    },
    {
      tokens: ['-c', 'approval_policy={ secret = true }'],
      option: 'approval_policy',
      problem: 'invalidValue'
    },
    { tokens: ['--config=sandbox_mode=secret'], option: 'sandbox_mode', problem: 'invalidValue' },
    {
      tokens: ['-c', 'approvals_reviewer=secret'],
      option: 'approvals_reviewer',
      problem: 'invalidValue'
    }
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
