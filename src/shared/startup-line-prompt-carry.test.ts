import { describe, expect, it } from 'vitest'
import { MAX_INLINE_LAUNCH_PROMPT_CHARS } from './launch-prompt-file'
import { planStartupWithLaunchPrompt } from './startup-line-prompt-carry'
import type { TuiAgent } from './tui-agent'
import { RUNTIME_CAPABILITIES } from './protocol-version'
import { AGENT_LAUNCH_PROMPT_CARRY_RUNTIME_CAPABILITY } from './agent-launch-runtime-capability'
import {
  TYPED_STARTUP_LINE_BUDGET_BYTES,
  WINDOWS_TYPED_STARTUP_LINE_MAX_CHARS,
  typedStartupLineFits,
  windowsTypedStartupLineFits
} from './typed-startup-line'

function plan(
  agent: TuiAgent,
  prompt: string,
  extra: {
    platform?: NodeJS.Platform
    shell?: 'cmd' | 'powershell'
    sensitive?: boolean
  } = {}
) {
  return planStartupWithLaunchPrompt(
    {
      agent,
      cmdOverrides: {},
      platform: extra.platform ?? 'darwin',
      ...(extra.shell ? { shell: extra.shell } : {})
    },
    prompt,
    extra.sensitive ? { sensitive: true } : {}
  )
}

describe('a launch prompt on the command line', () => {
  it('carries a short prompt inline', () => {
    const { plan: startup, launchFile } = plan('claude', 'explain this repo')
    expect(launchFile).toBeUndefined()
    expect(startup?.launchCommand).toContain('explain this repo')
    expect(startup?.followupPrompt).toBeNull()
  })

  it.each([
    ['a 600-byte', 'x'.repeat(600)],
    ['a multi-line', 'first line\nsecond line'],
    ['a key-bearing', 'see\tthis \x1b[31mred']
  ])('carries %s prompt whole on a POSIX host, which stages the typed line', (_label, prompt) => {
    const { plan: startup, launchFile } = plan('codex', prompt)
    expect(launchFile).toBeUndefined()
    expect(startup?.launchCommand).toContain(prompt)
    expect(startup?.followupPrompt).toBeNull()
  })

  it('points at a launch file past the argv ceiling, with the full text in the file', () => {
    const prompt = `${'y'.repeat(MAX_INLINE_LAUNCH_PROMPT_CHARS)}z`
    const { plan: startup, launchFile } = plan('claude', prompt)
    expect(launchFile?.content).toBe(prompt)
    expect(launchFile?.sensitive).toBe(false)
    expect(startup?.launchCommand).toContain(launchFile?.placeholder)
    expect(startup?.launchCommand).not.toContain('yyyy')
  })

  it('points a sensitive prompt at a launch file whatever its size', () => {
    const { plan: startup, launchFile } = plan('claude', 'token dcap_abc', { sensitive: true })
    expect(launchFile).toMatchObject({ content: 'token dcap_abc', sensitive: true })
    expect(startup?.launchCommand).not.toContain('dcap_abc')
  })

  it.each([
    ['cmd', 'first line\nsecond line'],
    ['powershell', 'first line\r\nsecond line']
  ] as const)(
    'points a multi-line prompt at a launch file on a Windows %s host, which cannot stage',
    (shell, prompt) => {
      const { plan: startup, launchFile } = plan('codex', prompt, { platform: 'win32', shell })
      expect(launchFile?.content).toBe(prompt)
      expect(startup?.launchCommand).not.toContain('first line')
      expect(typedStartupLineFits(startup?.launchCommand ?? '\n')).toBe(true)
    }
  )

  it('keeps a long single-line prompt inline on Windows up to cmd’s line cap', () => {
    const inline = plan('claude', 'x'.repeat(600), { platform: 'win32', shell: 'cmd' })
    expect(inline.launchFile).toBeUndefined()
    expect(inline.plan?.launchCommand).toContain('x'.repeat(600))

    const pastCap = plan('claude', 'x'.repeat(WINDOWS_TYPED_STARTUP_LINE_MAX_CHARS), {
      platform: 'win32',
      shell: 'cmd'
    })
    expect(pastCap.launchFile?.content).toBe('x'.repeat(WINDOWS_TYPED_STARTUP_LINE_MAX_CHARS))
  })

  it('carries a multi-line Hermes prompt in its spawn env, whose typed line never holds it', () => {
    const multiLine = 'line one\nline two'
    const { plan: startup, launchFile } = plan('hermes', multiLine, { platform: 'win32' })
    expect(launchFile).toBeUndefined()
    expect(startup?.launchCommand).not.toContain('line one')
    expect(Object.values(startup?.env ?? {})).toContain(multiLine)
  })

  it('leaves a Hermes prompt past its env budget for the paste after ready', () => {
    const { plan: startup, launchFile } = plan('hermes', 'x'.repeat(30_000))
    expect(launchFile).toBeUndefined()
    expect(startup?.launchCommand).toBe('hermes --tui')
    expect(startup?.followupPrompt).toBe('x'.repeat(30_000))
  })

  it('leaves CJK Hermes text under 16,384 chars but past its env bytes for the paste', () => {
    const cjk = '修'.repeat(9_000)
    const { plan: startup, launchFile } = plan('hermes', cjk)
    expect(launchFile).toBeUndefined()
    expect(startup?.followupPrompt).toBe(cjk)
  })

  it('puts a prompt that needs a launch file there only for an agent measured reading it', () => {
    const long = 'y'.repeat(MAX_INLINE_LAUNCH_PROMPT_CHARS + 1)
    expect(plan('claude', long).launchFile?.content).toBe(long)
    expect(plan('codex', long).launchFile?.content).toBe(long)
    for (const agent of ['gemini', 'cursor', 'antigravity', 'grok'] as const) {
      const { plan: startup, launchFile } = plan(agent, long)
      expect(launchFile).toBeUndefined()
      expect(startup?.followupPrompt).toBe(long)
      expect(startup?.launchCommand).not.toContain(long)
    }
  })

  it('pastes a Windows-damaged prompt for an agent not measured reading its launch file', () => {
    const { plan: startup, launchFile } = plan('gemini', 'line one\nline two', {
      platform: 'win32',
      shell: 'powershell'
    })
    expect(launchFile).toBeUndefined()
    expect(startup?.followupPrompt).toBe('line one\nline two')
  })

  it('leaves a stdin-after-start agent’s prompt for its caller to paste', () => {
    const { plan: startup, launchFile } = plan('aider', 'fix it')
    expect(launchFile).toBeUndefined()
    expect(startup?.followupPrompt).toBe('fix it')
  })

  it('launches clean for an empty prompt', () => {
    const { plan: startup, launchFile } = plan('claude', '   ')
    expect(launchFile).toBeUndefined()
    expect(startup?.launchCommand).toBe('claude')
  })
})

describe('whether a line can be typed as it is', () => {
  it('holds a POSIX line to half of macOS MAX_CANON', () => {
    expect(typedStartupLineFits('x'.repeat(TYPED_STARTUP_LINE_BUDGET_BYTES))).toBe(true)
    expect(typedStartupLineFits('x'.repeat(TYPED_STARTUP_LINE_BUDGET_BYTES + 1))).toBe(false)
    expect(typedStartupLineFits('é'.repeat(TYPED_STARTUP_LINE_BUDGET_BYTES / 2 + 1))).toBe(false)
  })

  it('holds a Windows line only to cmd’s cap', () => {
    expect(windowsTypedStartupLineFits('x'.repeat(WINDOWS_TYPED_STARTUP_LINE_MAX_CHARS))).toBe(true)
    expect(windowsTypedStartupLineFits('x'.repeat(WINDOWS_TYPED_STARTUP_LINE_MAX_CHARS + 1))).toBe(
      false
    )
  })

  it.each(['\n', '\r', '\t', '\x1b', '\x03', '\x7f'])('never types a line with %j', (byte) => {
    expect(typedStartupLineFits(`a${byte}b`)).toBe(false)
    expect(windowsTypedStartupLineFits(`a${byte}b`)).toBe(false)
  })
})

describe('the capability clients gate a prompted launch on', () => {
  it('is advertised by every host that delivers a prompt its typed line cannot carry as typed', () => {
    // An older host types any prompt into the line, so its absence is the gate.
    expect(RUNTIME_CAPABILITIES).toContain(AGENT_LAUNCH_PROMPT_CARRY_RUNTIME_CAPABILITY)
  })
})
