import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runProcess } from './child-process/run-process'
import {
  WINDOWS_ARGUMENT_CORPUS,
  WINDOWS_ARGUMENT_CORPUS_ENV
} from './child-process/__fixtures__/windows-argument-corpus'
import { removeTreeSync } from './windows-transient-lock-removal'
import { quoteStartupArg } from './tui-agent-startup-shell'
import { buildAgentStartupPlan } from './tui-agent-startup'
import { removeLaunchFile, writeLaunchFile } from './launch-file-writing'

/**
 * A launch line typed into a cmd pane is read by cmd's command-line parser, as stdin is here, then
 * by the agent's `.cmd` shim. Runs only on win32; skipped elsewhere.
 */
const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

describeOnWindows('cmd launch-line prompt quoting', () => {
  let dir: string
  let shim: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-cmd-startup-arg-'))
    shim = join(dir, 'echoargs.cmd')
    writeFileSync(shim, '@echo off\r\nnode "%~dp0echoargs.js" %*\r\n')
    writeFileSync(
      join(dir, 'echoargs.js'),
      'process.stdout.write(process.argv.slice(2).map((a) => `ARG<${a}>`).join("\\n") + "\\nEND\\n")\n'
    )
  })

  afterAll(() => {
    removeTreeSync(dir)
  })

  async function typeIntoCmd(line: string): Promise<string[]> {
    const result = await runProcess({
      program: 'cmd.exe',
      // cmd decodes piped stdin in the console code page; a real pane's input arrives as UTF-16.
      args: ['/d', '/q', '/k', 'chcp', '65001'],
      input: `${line}\r\nexit\r\n`,
      env: { ...process.env, ...WINDOWS_ARGUMENT_CORPUS_ENV },
      timeoutMs: 30_000
    })
    const block = /((?:ARG<[\s\S]*?>\n?)*)END/.exec(result.stdout.replace(/\r\n/g, '\n'))?.[1] ?? ''
    return [...block.matchAll(/ARG<([\s\S]*?)>(?=\nARG<|\n?$)/g)].map((match) => match[1]!)
  }

  it('delivers a short prompt with no stray carets', async () => {
    const prompt = 'Fix (the) build & ship 100% of it! ^_^'
    expect(await typeIntoCmd(`"${shim}" ${quoteStartupArg(prompt, 'cmd')}`)).toEqual([prompt])
  })

  it.each(WINDOWS_ARGUMENT_CORPUS.filter(({ value }) => value !== ''))(
    'delivers $name unchanged',
    async ({ value }) => {
      expect(await typeIntoCmd(`"${shim}" ${quoteStartupArg(value, 'cmd')}`)).toEqual([value])
    }
  )

  it('never lets a multi-line prompt reach cmd as commands: the line names a launch file', async () => {
    const marker = join(dir, 'pwned.txt')
    const prompt = `Fix the build\r\n& echo PWNED> "${marker}"\nthen run the tests`
    const plan = buildAgentStartupPlan({
      agent: 'claude',
      prompt,
      cmdOverrides: { claude: shim },
      platform: 'win32',
      shell: 'cmd'
    })
    const launchFile = plan?.launchFile
    if (!plan || !launchFile) {
      throw new Error('a multi-line cmd prompt must ride a launch file')
    }
    // What the host does before typing: write the file, put its path where the placeholder was.
    const written = writeLaunchFile({
      launchFile,
      command: plan.launchCommand,
      platform: 'win32'
    })
    try {
      const typed = written.command ?? ''
      expect(typed).not.toMatch(/[\r\n]/)
      const args = await typeIntoCmd(typed)
      expect(args).toHaveLength(1)
      expect(args[0]).toContain(written.path)
      expect(readFileSync(written.path, 'utf8')).toBe(prompt)
      expect(existsSync(marker)).toBe(false)
    } finally {
      removeLaunchFile(written)
    }
  })

  it('names a launch file under a home with an apostrophe, accents, CJK and `%`', async () => {
    const home = join(dir, "O'Brien José 张伟 100%")
    mkdirSync(home)
    const plan = buildAgentStartupPlan({
      agent: 'claude',
      prompt: 'Fix the build\nthen run the tests',
      cmdOverrides: { claude: shim },
      platform: 'win32',
      shell: 'cmd'
    })
    const launchFile = plan?.launchFile
    if (!plan || !launchFile) {
      throw new Error('a multi-line cmd prompt must ride a launch file')
    }
    const written = writeLaunchFile({
      launchFile,
      command: plan.launchCommand,
      platform: 'win32',
      baseDirectory: home
    })
    try {
      const args = await typeIntoCmd(written.command ?? '')
      expect(args).toHaveLength(1)
      expect(args[0]).toContain(written.path)
    } finally {
      removeLaunchFile(written)
    }
  })
})
