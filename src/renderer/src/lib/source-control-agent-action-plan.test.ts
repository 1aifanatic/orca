import { describe, expect, it } from 'vitest'
import { planSourceControlAgentActionLaunch } from './source-control-agent-action-plan'

describe('planSourceControlAgentActionLaunch', () => {
  it('rejects disabled agents', () => {
    expect(
      planSourceControlAgentActionLaunch({
        agent: 'codex',
        commandInput: 'Fix checks',
        promptDelivery: 'submit-after-ready',
        detectedAgents: ['codex'],
        disabledAgents: ['codex'],
        platform: 'darwin'
      })
    ).toEqual({ ok: false, error: 'The selected agent is disabled in Settings.' })
  })

  it('rejects agents not detected on the current host', () => {
    expect(
      planSourceControlAgentActionLaunch({
        agent: 'claude',
        commandInput: 'Fix checks',
        promptDelivery: 'submit-after-ready',
        detectedAgents: ['codex'],
        platform: 'linux'
      })
    ).toEqual({ ok: false, error: 'The selected agent was not detected on this workspace host.' })
  })

  it('carries a submit-after-ready prompt on the command line of an agent that takes one', () => {
    const result = planSourceControlAgentActionLaunch({
      agent: 'codex',
      commandInput: 'Fix checks',
      promptDelivery: 'submit-after-ready',
      detectedAgents: ['codex'],
      platform: 'linux'
    })

    expect(result.ok && result.delivery).toBe('argv')
    expect(result.ok && result.commandLabel).toBe("codex 'Fix checks'")
    expect(result.ok && result.summary).toContain('included in the launch command')
    expect(result.ok && result.caveat).toContain('PATH')
  })

  it('says an input past the argv ceiling goes in a private file, not on the command line', () => {
    const result = planSourceControlAgentActionLaunch({
      agent: 'codex',
      commandInput: 'z'.repeat(200_000),
      promptDelivery: 'submit-after-ready',
      detectedAgents: ['codex'],
      platform: 'linux'
    })

    expect(result.ok && result.summary).toContain('private file')
    expect(result.ok && result.summary).not.toContain('included in the launch command')
  })

  it('includes per-action CLI arguments in submit-after-ready launch plans', () => {
    const result = planSourceControlAgentActionLaunch({
      agent: 'codex',
      commandInput: 'Fix checks',
      agentArgs: '--model gpt-5.5',
      promptDelivery: 'submit-after-ready',
      detectedAgents: ['codex'],
      platform: 'linux'
    })

    expect(result.ok && result.commandLabel).toBe("codex '--model' 'gpt-5.5' 'Fix checks'")
  })

  it('still pastes and submits for an agent that takes its text only after start', () => {
    const result = planSourceControlAgentActionLaunch({
      agent: 'amp',
      commandInput: 'Fix checks',
      promptDelivery: 'submit-after-ready',
      detectedAgents: ['amp'],
      platform: 'linux'
    })

    expect(result.ok && result.delivery).toBe('paste-submit')
    expect(result.ok && result.summary).toContain('pastes and submits')
  })

  it.each([
    {
      terminalWindowsShell: 'cmd.exe',
      expectedCommand: 'powershell.exe -NoProfile -EncodedCommand'
    },
    {
      terminalWindowsShell: 'git-bash',
      expectedCommand: 'ORCA_HERMES_STARTUP_QUERY'
    }
  ])(
    'uses $terminalWindowsShell quoting for Hermes source-control prompts',
    ({ terminalWindowsShell, expectedCommand }) => {
      const result = planSourceControlAgentActionLaunch({
        agent: 'hermes',
        commandInput: 'Review the change',
        promptDelivery: 'auto-submit',
        detectedAgents: ['hermes'],
        platform: 'win32',
        terminalWindowsShell
      })

      expect(result.ok && result.plan.launchCommand).toContain(expectedCommand)
      expect(result.ok && result.plan.env?.ORCA_HERMES_STARTUP_QUERY).toBe('Review the change')
    }
  )

  it('rejects invalid per-action CLI arguments', () => {
    expect(
      planSourceControlAgentActionLaunch({
        agent: 'codex',
        commandInput: 'Fix checks',
        agentArgs: '--model "unterminated',
        promptDelivery: 'submit-after-ready',
        detectedAgents: ['codex'],
        platform: 'linux'
      })
    ).toEqual({
      ok: false,
      error: 'CLI arguments are invalid: Unclosed quote in command template.'
    })
  })

  it('uses native draft launch when the selected agent supports it', () => {
    const result = planSourceControlAgentActionLaunch({
      agent: 'claude',
      commandInput: 'Fix checks',
      promptDelivery: 'draft',
      detectedAgents: ['claude'],
      platform: 'darwin'
    })

    expect(result.ok && result.delivery).toBe('draft-native')
    expect(result.ok && result.commandLabel).toContain('--prefill')
  })
})
