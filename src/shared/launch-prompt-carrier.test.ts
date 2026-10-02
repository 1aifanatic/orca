import { describe, expect, it } from 'vitest'
import { buildAgentStartupPlan } from './tui-agent-startup'

const base = { agent: 'claude' as const, cmdOverrides: {} }

describe('the one launch-prompt decision every launch path builds through', () => {
  // Why: the composer, phone quick commands and background sessions call the builder directly.
  it('points a single-line prompt past cmd’s line cap at a launch file', () => {
    const prompt = 'y'.repeat(9_000)
    const plan = buildAgentStartupPlan({ ...base, prompt, platform: 'win32', shell: 'cmd' })
    expect(plan?.launchFile?.content).toBe(prompt)
    expect(plan?.launchCommand.length).toBeLessThan(8_191)
  })

  it('points a prompt past the argv ceiling at a launch file on a POSIX host too', () => {
    const prompt = 'z'.repeat(20_000)
    expect(buildAgentStartupPlan({ ...base, prompt, platform: 'linux' })?.launchFile?.content).toBe(
      prompt
    )
  })

  it('keeps a sensitive prompt off the line however short it is', () => {
    const plan = buildAgentStartupPlan({
      ...base,
      prompt: 'token dcap_secret',
      platform: 'linux',
      sensitive: true
    })
    expect(plan?.launchFile).toMatchObject({ content: 'token dcap_secret', sensitive: true })
    expect(plan?.launchCommand).not.toContain('dcap_secret')
  })

  // Why: the host writes a WSL session's staged line and launch file into the distro.
  it('plans a WSL launch like any Linux launch: long lines stay typed, huge ones get a file', () => {
    const typed = buildAgentStartupPlan({ ...base, platform: 'linux', prompt: 'one\ntwo' })
    expect(typed?.launchCommand).toContain('two')
    expect(typed?.followupPrompt).toBeNull()
    const huge = 'c'.repeat(20_000)
    const pointed = buildAgentStartupPlan({ ...base, platform: 'linux', prompt: huge })
    expect(pointed?.launchFile?.content).toBe(huge)
    expect(pointed?.followupPrompt).toBeNull()
  })
})
