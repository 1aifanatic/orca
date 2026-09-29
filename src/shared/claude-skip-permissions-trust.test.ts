import { describe, expect, it } from 'vitest'
import { buildAgentStartupPlan } from './tui-agent-startup'
import { buildAgentResumeStartupPlan } from './tui-agent-resume-startup'

function claudePlan(agentArgs: string, platform: NodeJS.Platform = 'darwin') {
  return buildAgentStartupPlan({
    agent: 'claude',
    prompt: '',
    cmdOverrides: {},
    platform,
    allowEmptyPromptLaunch: true,
    agentArgs
  })
}

describe('Claude skip-permissions trust bypass', () => {
  it('scopes CLAUDE_CODE_SANDBOXED to the Claude process, never the pane env', () => {
    const plan = claudePlan('--dangerously-skip-permissions')
    expect(plan?.launchCommand).toMatch(
      /^CLAUDE_CODE_SANDBOXED=1 claude '?--dangerously-skip-permissions'?$/
    )
    expect(plan?.env?.CLAUDE_CODE_SANDBOXED).toBeUndefined()
  })

  it('counts a quoted flag, which the shell unquotes into the real flag', () => {
    expect(claudePlan("'--dangerously-skip-permissions'")?.launchCommand).toMatch(
      /^CLAUDE_CODE_SANDBOXED=1 claude /
    )
  })

  it('ignores near-miss flags, positional text and launches without the flag', () => {
    for (const args of [
      '',
      '--dangerously-skip-permissions-x',
      '-- --dangerously-skip-permissions',
      '--permission-mode default'
    ]) {
      expect(claudePlan(args)?.launchCommand).not.toContain('CLAUDE_CODE_SANDBOXED')
    }
  })

  it('leaves other agents alone', () => {
    const plan = buildAgentStartupPlan({
      agent: 'openclaude',
      prompt: '',
      cmdOverrides: {},
      platform: 'darwin',
      allowEmptyPromptLaunch: true,
      agentArgs: '--dangerously-skip-permissions'
    })
    expect(plan?.launchCommand).not.toContain('CLAUDE_CODE_SANDBOXED')
  })

  it('keeps the prompt on Windows shells, which have no per-process form', () => {
    expect(claudePlan('--dangerously-skip-permissions', 'win32')?.launchCommand).not.toContain(
      'CLAUDE_CODE_SANDBOXED'
    )
  })

  it('carries the bypass into Agent Teams launches and resumes', () => {
    const teams = buildAgentStartupPlan({
      agent: 'claude-agent-teams',
      prompt: '',
      cmdOverrides: {},
      platform: 'darwin',
      allowEmptyPromptLaunch: true,
      agentArgs: '--dangerously-skip-permissions'
    })
    expect(teams?.launchCommand).toMatch(/^CLAUDE_CODE_SANDBOXED=1 orca claude-teams /)
    const resume = buildAgentResumeStartupPlan({
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'abc' },
      cmdOverrides: {},
      platform: 'darwin',
      agentArgs: '--dangerously-skip-permissions'
    })
    expect(resume?.launchCommand).toMatch(
      /^CLAUDE_CODE_SANDBOXED=1 claude '?--dangerously-skip-permissions'? '?--resume'? '?abc'?$/
    )
  })
})
