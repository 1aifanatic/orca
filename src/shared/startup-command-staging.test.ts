import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  STAGED_STARTUP_COMMAND_STALE_MS,
  discardStagedStartupCommand,
  stageStartupCommand,
  startupStagingFailureNotice,
  sweepStaleStagedStartupCommands
} from './startup-command-staging'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-staging-test-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function stage(command: string, shellPath = '/bin/zsh', platform: NodeJS.Platform = 'darwin') {
  return stageStartupCommand({ command, shellPath, platform, directory })
}

describe('stageStartupCommand', () => {
  it('types a short single-line command as is', () => {
    expect(stage(`claude 'fix it'`)).toEqual({ command: `claude 'fix it'`, delivery: 'typed' })
    expect(readdirSync(directory)).toEqual([])
  })

  it('types exactly 512 bytes, stages 513', () => {
    expect(stage('a'.repeat(512)).delivery).toBe('typed')
    expect(stage('a'.repeat(513)).delivery).toBe('staged')
  })

  it('measures bytes, not characters', () => {
    expect(stage('é'.repeat(257)).delivery).toBe('staged')
  })

  it('ignores a trailing submit byte when measuring', () => {
    expect(stage(`${'a'.repeat(512)}\n`).delivery).toBe('typed')
    expect(stage(`${'a'.repeat(512)}\r\n`).delivery).toBe('typed')
  })

  it.each([['\n'], ['\r'], ['\t'], ['\x1b'], ['\x03'], ['\x7f']])(
    'stages a short line carrying control byte %j',
    (byte) => {
      expect(stage(`claude 'a${byte}b'`).delivery).toBe('staged')
    }
  )

  it('writes a 0600 script whose body is exactly the command, and types a sourcing line', () => {
    const command = `claude '${'x'.repeat(600)}'`
    const staged = stage(`${command}\n`)
    expect(staged.delivery).toBe('staged')
    expect(staged.scriptPath).toBeDefined()
    const scriptPath = staged.scriptPath!
    expect(staged.command).toBe(`. '${scriptPath}'`)
    expect(statSync(scriptPath).mode & 0o777).toBe(0o600)
    expect(readFileSync(scriptPath, 'utf8')).toBe(`command rm -f -- '${scriptPath}'\n${command}\n`)
  })

  it('sources with `source` in fish', () => {
    const staged = stage('a'.repeat(600), '/opt/homebrew/bin/fish')
    expect(staged.command).toBe(`source '${staged.scriptPath}'`)
  })

  it('recognizes a login shell name', () => {
    expect(stage('a'.repeat(600), '-zsh').delivery).toBe('staged')
  })

  it('sources the script in ksh like sh', () => {
    const staged = stage('a'.repeat(600), '/bin/ksh')
    expect(staged.command).toBe(`. '${staged.scriptPath}'`)
  })

  // Why: typed raw, tcsh runs a prompt's second line as a command and MAX_CANON cuts a long one.
  it.each([['/usr/bin/nu'], ['/bin/tcsh'], ['/usr/local/bin/pwsh'], [undefined]])(
    'runs an Orca-built launch line through /bin/sh for a shell that cannot source it (%s)',
    (shellPath) => {
      const staged = stageStartupCommand({
        command: `claude 'one\ntwo'`,
        shellPath,
        orcaBuiltLine: true,
        platform: 'darwin',
        directory
      })
      expect(staged.delivery).toBe('staged')
      expect(staged.command).toBe(`/bin/sh '${staged.scriptPath}'`)
    }
  )

  // Measured: tcsh typed `'fix C:'"\\"'dir'` as `fix C:\\dir` and expanded `!!` in `'wow!! great'`.
  it.each([['/bin/tcsh'], ['/usr/bin/nu'], [undefined]])(
    'stages even a short Orca-built line for a shell that cannot source it (%s)',
    (shellPath) => {
      const command = `claude 'wow!! great'`
      const staged = stageStartupCommand({
        command,
        shellPath,
        orcaBuiltLine: true,
        platform: 'darwin',
        directory
      })
      expect(staged.command).toBe(`/bin/sh '${staged.scriptPath}'`)
      expect(readFileSync(staged.scriptPath!, 'utf8')).toContain(`\n${command}\n`)
    }
  )

  it('types a short Orca-built line in a shell that reads its quoting literally', () => {
    const command = `claude 'wow!! great'`
    expect(
      stageStartupCommand({ command, shellPath: '/bin/zsh', orcaBuiltLine: true, directory })
    ).toEqual({ command, delivery: 'typed' })
  })

  // Why: a quick command or --command written for tcsh or nu is not sh syntax.
  it.each([['/bin/tcsh'], ['/usr/bin/nu'], [undefined]])(
    'types a command the user wrote as it always was in a shell that cannot source it (%s)',
    (shellPath) => {
      const command = `foreach f (*.log)\n  echo $f\nend`
      const staged = stageStartupCommand({ command, shellPath, platform: 'darwin', directory })
      expect(staged).toEqual({ command, delivery: 'typed' })
      expect(readdirSync(directory)).toEqual([])
    }
  )

  it('leaves Windows hosts alone', () => {
    expect(stage('a'.repeat(600), 'C:\\Program Files\\Git\\bin\\bash.exe', 'win32').delivery).toBe(
      'typed'
    )
    expect(stage('a'.repeat(600), '/bin/bash', 'win32').delivery).toBe('typed')
  })

  it('types the full command and says so when the script cannot be written', () => {
    const command = 'a'.repeat(600)
    const staged = stageStartupCommand({
      command,
      shellPath: '/bin/bash',
      platform: 'linux',
      directory: join(directory, 'missing')
    })
    expect(staged.command).toBe(command)
    expect(staged.delivery).toBe('typed-after-stage-failed')
    expect(staged.failure).toMatch(/ENOENT/)
    expect(staged.scriptPath).toBeUndefined()
  })

  it('gives every launch its own script', () => {
    const first = stage('a'.repeat(600))
    const second = stage('a'.repeat(600))
    expect(first.scriptPath).not.toBe(second.scriptPath)
  })
})

describe('discardStagedStartupCommand', () => {
  it('removes a script the shell never sourced', () => {
    const staged = stage('a'.repeat(600))
    discardStagedStartupCommand(staged)
    expect(readdirSync(directory)).toEqual([])
  })

  it('is a no-op once the script deleted itself', () => {
    const staged = stage('a'.repeat(600))
    rmSync(staged.scriptPath!)
    expect(() => discardStagedStartupCommand(staged)).not.toThrow()
  })
})

describe('sweepStaleStagedStartupCommands', () => {
  it('removes only staged scripts older than an hour', () => {
    const now = Date.now()
    const stale = join(directory, 'orca-launch-aaaa.sh')
    const fresh = join(directory, 'orca-launch-bbbb.sh')
    const unrelated = join(directory, 'something-else.sh')
    for (const path of [stale, fresh, unrelated]) {
      writeFileSync(path, '')
    }
    const staleSeconds = (now - STAGED_STARTUP_COMMAND_STALE_MS - 1000) / 1000
    utimesSync(stale, staleSeconds, staleSeconds)
    utimesSync(unrelated, staleSeconds, staleSeconds)
    sweepStaleStagedStartupCommands({ directory, now })
    expect(readdirSync(directory).sort()).toEqual(['orca-launch-bbbb.sh', 'something-else.sh'])
  })
})

describe('startupStagingFailureNotice', () => {
  it('says nothing when staging did not fail', () => {
    expect(startupStagingFailureNotice(stage(`claude 'fix it'`))).toBeNull()
    expect(startupStagingFailureNotice(stage(`claude '${'x'.repeat(600)}'`))).toBeNull()
  })

  it('prints one line naming the failure, with no control bytes from the reason', () => {
    const notice = startupStagingFailureNotice({
      command: 'x',
      delivery: 'typed-after-stage-failed',
      failure: 'EACCES: permission denied\nsecond line'
    })
    expect(notice).toBe(
      '\r\n[orca] Could not stage the launch command (EACCES: permission denied second line); typed it in full. If the shell shows quote> or waits for more input, press Ctrl-C and launch again.\r\n'
    )
  })
})
