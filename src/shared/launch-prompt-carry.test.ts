import { describe, expect, it } from 'vitest'
import { MAX_INLINE_LAUNCH_PROMPT_CHARS, carryInLaunchFile } from './launch-prompt-file'
import { planLaunchPrompt, type AgentLaunchPromptArgs } from './tui-agent-startup'
import type { TuiAgent } from './tui-agent'
import { RUNTIME_CAPABILITIES } from './protocol-version'
import { AGENT_LAUNCH_PROMPT_CARRY_RUNTIME_CAPABILITY } from './agent-launch-runtime-capability'
import { TYPED_STARTUP_LINE_BUDGET_BYTES, typedStartupLineFits } from './typed-startup-line'
import { describeLaunchHost } from './launch-host'
import { WINDOWS_TYPED_LINE_MAX_CHARS } from './launch-prompt-carry'

function plan(
  agent: TuiAgent,
  prompt: string,
  extra: Partial<Omit<AgentLaunchPromptArgs, 'agent' | 'prompt'>> = {}
) {
  const platform = extra.platform ?? 'darwin'
  // A local launch on that platform, by a caller that pastes, unless the test says otherwise.
  const host = describeLaunchHost({
    launchPlatform: platform,
    isRemote: false,
    hostPlatform: platform,
    paired: false
  })
  return planLaunchPrompt({
    agent,
    prompt,
    cmdOverrides: {},
    platform,
    host,
    canPasteAfterReady: true,
    ...extra
  })
}

describe('where a launch prompt rides', () => {
  it('builds a plain launch for an empty prompt', () => {
    expect(plan('claude', '  ')).toMatchObject({ carry: 'none' })
  })

  it('carries a short prompt on the line', () => {
    const planned = plan('claude', 'explain this repo')
    expect(planned?.carry).toBe('on-line')
    expect(planned?.carry === 'on-line' && planned.plan.launchCommand).toContain(
      'explain this repo'
    )
  })

  it.each([
    ['a 600-byte', 'x'.repeat(600)],
    ['a multi-line', 'first line\nsecond line'],
    ['a key-bearing', 'see\tthis \x1b[31mred']
  ])('carries %s prompt on the line of a POSIX host, which stages it', (_label, prompt) => {
    const planned = plan('codex', prompt)
    expect(planned?.carry).toBe('on-line')
    expect(planned?.carry === 'on-line' && planned.plan.launchCommand).toContain(prompt)
  })

  it.each<TuiAgent>(['claude', 'codex'])(
    'points %s at a launch file past the argv ceiling, with the full text in the file',
    (agent) => {
      const prompt = `${'y'.repeat(MAX_INLINE_LAUNCH_PROMPT_CHARS)}z`
      const planned = plan(agent, prompt)
      if (planned?.carry !== 'launch-file') {
        throw new Error(`expected a launch file, got ${planned?.carry}`)
      }
      expect(planned.launchFile).toMatchObject({ content: prompt, sensitive: false })
      expect(planned.plan.launchCommand).toContain(planned.launchFile.placeholder)
      expect(planned.plan.launchCommand).not.toContain('yyyy')
    }
  )

  // The bug class this outcome removes: a plan that exists but does not carry the prompt.
  it('leaves a file-sized prompt for the paste for an agent not measured reading the file', () => {
    const prompt = 'g'.repeat(MAX_INLINE_LAUNCH_PROMPT_CHARS + 1)
    const planned = plan('gemini', prompt)
    if (planned?.carry !== 'paste-after-ready') {
      throw new Error(`expected the paste, got ${planned?.carry}`)
    }
    expect(planned.text).toBe(prompt)
    expect(planned.cleanPlan.launchCommand).not.toContain('gggg')
  })

  // Why: main started such an agent with the whole prompt on its line; a caller with no paste
  // (agentSession.create, a phone quick command) must not refuse it now.
  it('keeps a file-sized prompt on the line for a caller that cannot paste', () => {
    const prompt = 'g'.repeat(MAX_INLINE_LAUNCH_PROMPT_CHARS + 1)
    const planned = plan('gemini', prompt, { canPasteAfterReady: false })
    expect(planned?.carry).toBe('on-line')
    expect(planned?.carry === 'on-line' && planned.plan.launchCommand).toContain('gggg')
  })

  it('leaves a stdin-after-start agent’s prompt for the paste', () => {
    const planned = plan('aider', 'fix it')
    expect(planned).toMatchObject({ carry: 'paste-after-ready', text: 'fix it' })
  })

  it('names a launch file its caller wrote, quoted for the line', () => {
    const { prompt, launchFile } = carryInLaunchFile('worker brief', true)
    const planned = plan('claude', prompt, { launchFile })
    expect(planned).toMatchObject({
      carry: 'launch-file',
      launchFile: { ...launchFile, quoting: 'posix' }
    })
  })
})

describe('a host that types the line raw', () => {
  // Why: the user's own words stay in the agent's history wherever a Windows line carries them.
  it.each<['cmd' | 'powershell']>([['cmd'], ['powershell']])(
    'keeps an exact %s line up to cmd’s cap and points Claude at a file past it',
    (shell) => {
      expect(plan('claude', 'fix it', { platform: 'win32', shell })?.carry).toBe('on-line')
      expect(plan('claude', 'y'.repeat(4_000), { platform: 'win32', shell })?.carry).toBe('on-line')
      const past = plan('claude', 'y'.repeat(WINDOWS_TYPED_LINE_MAX_CHARS), {
        platform: 'win32',
        shell
      })
      expect(past?.carry).toBe('launch-file')
    }
  )

  // The measured matrix (#23962 W-1): PowerShell splits at `"`, turns a trailing `\` into `"`, and
  // a .cmd shim expands `%NAME%`; everything else arrives byte for byte.
  it.each([
    ['a double quote', 'say "hi"', 'launch-file'],
    ['a trailing backslash', 'see C:\\dir\\', 'launch-file'],
    ['a %NAME% pair', 'echo %PATH%', 'launch-file'],
    ['a lone percent and an apostrophe', "it's 100% done", 'on-line']
  ] as const)(
    'carries a PowerShell prompt with %s by the measured matrix',
    (_label, text, carry) => {
      expect(plan('claude', text, { platform: 'win32', shell: 'powershell' })?.carry).toBe(carry)
    }
  )

  it('points Codex at a file for a Windows-damaged prompt, and keeps it on Gemini’s line', () => {
    const prompt = 'fix the build\nthen run the tests'
    expect(plan('codex', prompt, { platform: 'win32', shell: 'cmd' })?.carry).toBe('launch-file')
    // A Windows host cannot prove Gemini is in front to paste into, so it types it as main did.
    expect(plan('gemini', prompt, { platform: 'win32', shell: 'cmd' })?.carry).toBe('on-line')
  })

  // Why: a host that cannot prove the agent holds its terminal refuses a paste (#24257), so the
  // line carries what the paste would have, as main typed it; Claude and Codex still get the file.
  it('keeps a prompt on the line of a host that cannot paste, unless a file can carry it', () => {
    // A local WSL pane: a Linux line, on a Windows host that cannot read what holds it.
    const extra = {
      platform: 'linux' as const,
      host: { paired: false, provesAgentInFront: false }
    }
    const prompt = 'fix the build\nthen run the tests'
    expect(plan('gemini', prompt, extra)?.carry).toBe('on-line')
    expect(plan('gemini', 'y'.repeat(20_000), extra)?.carry).toBe('on-line')
    expect(plan('claude', 'y'.repeat(20_000), extra)?.carry).toBe('launch-file')
    expect(plan('aider', prompt, extra)?.carry).toBe('paste-after-ready')
  })

  it('pastes on a paired host what its line cannot carry typed, even for Claude', () => {
    const extra = { platform: 'linux' as const, host: { paired: true, provesAgentInFront: true } }
    expect(plan('claude', 'fix it', extra)?.carry).toBe('on-line')
    expect(plan('claude', 'first line\nsecond line', extra)?.carry).toBe('paste-after-ready')
    expect(plan('claude', 'z'.repeat(20_000), extra)?.carry).toBe('paste-after-ready')
  })
})

describe('whether a line can be typed as it is', () => {
  it('holds a line to half of macOS MAX_CANON', () => {
    expect(typedStartupLineFits('x'.repeat(TYPED_STARTUP_LINE_BUDGET_BYTES))).toBe(true)
    expect(typedStartupLineFits('x'.repeat(TYPED_STARTUP_LINE_BUDGET_BYTES + 1))).toBe(false)
  })

  it.each(['\n', '\r', '\t', '\x1b', '\x03', '\x7f'])('never types a line with %j', (byte) => {
    expect(typedStartupLineFits(`a${byte}b`)).toBe(false)
  })
})

describe('the capability clients gate a prompted launch on', () => {
  it('is advertised by every host that delivers a prompt its typed line cannot carry as typed', () => {
    // An older host types any prompt into the line, so its absence is the gate.
    expect(RUNTIME_CAPABILITIES).toContain(AGENT_LAUNCH_PROMPT_CARRY_RUNTIME_CAPABILITY)
  })
})
