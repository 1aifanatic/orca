import { describe, expect, it } from 'vitest'
import { buildLaunchFilePointer, isLaunchFilePointer } from './launch-prompt-file'
import { buildAgentDraftLaunchPlan, buildAgentStartupPlan } from './tui-agent-startup'
import type { AgentStartupShell } from './tui-agent-startup-shell'
import { windowsDraftRefusal } from './startup-plan-launch-file'

function plan(prompt: string, shell: AgentStartupShell) {
  return buildAgentStartupPlan({
    agent: 'claude',
    prompt,
    cmdOverrides: {},
    platform: shell === 'posix' ? 'darwin' : 'win32',
    shell
  })
}

describe('a prompt a Windows shell would damage on the launch line', () => {
  // Measured (ps-quoting-matrix.md): PowerShell 5.1, and 7.x through a .cmd shim, split a `"` out of
  // the plain literal and turn a trailing backslash into `"`; the legacy-passing escape would let a
  // .cmd shim's cmd.exe run `&` and `<>` from inside the user's quotes. So these ride a launch file.
  it.each([
    ['P1', 'fix the "foo bar" bug'],
    ['P2', '"leading quote" then text'],
    ['P3', 'trailing "quote"'],
    ['P4', 'a \\"backslash-quote\\" b'],
    ['P5', 'back\\slash\\\\ "q" end\\'],
    ['P7', 'replace "<b>" with "a & b"'],
    ['a bare path', 'see C:\\dir\\']
  ])('moves %s into a launch file on PowerShell', (_, prompt) => {
    const startup = plan(prompt, 'powershell')
    expect(startup?.launchFile?.content).toBe(prompt)
    expect(startup?.launchCommand).not.toContain('"')
    expect(startup?.launchCommand).not.toContain('Legacy')
  })

  // Measured form F-A: a pointer to a spaced path passed in every PowerShell and target.
  it('types P6, the backtick pointer, and quote-free prompts as a plain literal', () => {
    const prompt = 'The full task is in the file `C:\\Users\\John Smith\\t.md`. Read it.'
    expect(plan(prompt, 'powershell')?.launchCommand).toBe(`claude '${prompt}'`)
    expect(plan("fix Bob's build", 'powershell')?.launchCommand).toBe("claude 'fix Bob''s build'")
  })

  // Measured (QA-WIN R0-R2): through a `.cmd` shim, `%PATH%` reached the agent as 1,795 characters.
  it('moves a %NAME% pair into a launch file on PowerShell and keeps a lone percent typed', () => {
    expect(plan('echo %PATH% for me', 'powershell')?.launchFile?.content).toBe('echo %PATH% for me')
    expect(plan('coverage is 80% now', 'powershell')?.launchCommand).toBe(
      "claude 'coverage is 80% now'"
    )
    expect(plan('echo %PATH% for me', 'cmd')?.launchFile).toBeUndefined()
  })

  it('keeps `"` on the line for cmd and POSIX, whose quoting carries it', () => {
    expect(plan('fix the "foo bar" bug', 'cmd')?.launchFile).toBeUndefined()
    expect(plan('fix the "foo bar" bug', 'posix')?.launchFile).toBeUndefined()
  })

  it('pastes a PowerShell draft holding `"` or ending in `\\` instead of prefilling it', () => {
    const draft = (text: string) =>
      buildAgentDraftLaunchPlan({
        agent: 'claude',
        draft: text,
        cmdOverrides: {},
        platform: 'win32',
        shell: 'powershell'
      })
    expect(draft('say "hi"')).toBeNull()
    expect(draft('see C:\\dir\\')).toBeNull()
    expect(draft('say hi')?.launchCommand).toBe("claude --prefill 'say hi'")
  })

  it('points at the file with no double quote in the sentence', () => {
    const path = 'C:\\Users\\John Smith\\AppData\\Local\\Temp\\orca-launch-file-a1\\task-context.md'
    expect(buildLaunchFilePointer(path)).toBe(
      `The full task is in the file \`${path}\`. Read it and complete the task it describes.`
    )
  })

  it('launches clean and leaves the prompt for the paste when the host writes no launch file', () => {
    const startup = buildAgentStartupPlan({
      agent: 'claude',
      prompt: 'fix the build\nthen run the tests',
      cmdOverrides: {},
      platform: 'win32',
      shell: 'powershell',
      hostWritesLaunchFile: false
    })
    expect(startup?.launchFile).toBeUndefined()
    expect(startup?.launchCommand).toBe('claude')
    expect(startup?.followupPrompt).toBe('fix the build\nthen run the tests')
  })

  it('tells its own pointer apart from a prompt that merely mentions one', () => {
    expect(isLaunchFilePointer(buildLaunchFilePointer('C:\\Temp\\a b\\task-context.md'))).toBe(true)
    expect(isLaunchFilePointer('The full task is in the file `x`. Read it and do it.')).toBe(false)
    expect(isLaunchFilePointer('fix the build')).toBe(false)
  })

  it('says in plain words why a Windows shell draft was not launched', () => {
    expect(windowsDraftRefusal('line one\nline two', 'powershell')).toMatch(
      /Windows shell would break this draft on the agent's command line \(it has a line break or other control character, or on PowerShell a double quote, a %NAME% pair or a trailing backslash\), so the agent was not started/
    )
    expect(windowsDraftRefusal('see C:\\dir\\', 'powershell')).not.toBeNull()
    expect(windowsDraftRefusal('say "hi"', 'powershell')).not.toBeNull()
    expect(windowsDraftRefusal('say "hi"', 'cmd')).toBeNull()
    expect(windowsDraftRefusal('line one\nline two', 'posix')).toBeNull()
  })
})
