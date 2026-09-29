import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import { getWindowsManagedLifecycleHook } from '../claude/hook-settings'

const command = getWindowsManagedLifecycleHook(
  'C:\\Users\\alice\\.orca\\agent-hooks\\claude-hook.cmd'
).command
const input = '{"message":"café 日本語 & %PATH%", "hook_event_name":"Stop"}'

// A POSIX fixture at the exact registered spelling exercises tokenization, not Windows batch execution.
describe.skipIf(process.platform === 'win32')('Windows command under available POSIX hosts', () => {
  for (const shell of ['/bin/bash', '/bin/zsh', '/opt/homebrew/bin/pwsh', '/usr/bin/pwsh']) {
    it.skipIf(!existsSync(shell))(
      `preserves invocation and reports a missing entry without exit 2: ${shell}`,
      async () => {
        const root = mkdtempSync(join(tmpdir(), 'claude-command-host-'))
        const fixture = join(root, 'C:/Users/alice/.orca/agent-hooks/claude-hook.cmd')
        const shellArgs = shell.endsWith('pwsh') ? ['-NoProfile', '-Command'] : ['-c']
        // PowerShell needs a drive mapping on POSIX; its Windows behavior is tested on Windows.
        const invocation = shell.endsWith('pwsh')
          ? `New-PSDrive -Name C -PSProvider FileSystem -Root './C:' | Out-Null; ${command}`
          : command
        const run = () =>
          runProcess({
            program: '/usr/bin/env',
            args: ['-i', `HOME=${root}`, 'PATH=/usr/bin:/bin', shell, ...shellArgs, invocation],
            cwd: root,
            env: {},
            input,
            timeoutMs: 5_000
          })
        try {
          mkdirSync(dirname(fixture), { recursive: true })
          writeFileSync(fixture, '#!/bin/sh\nprintf "{}\\n"\ncat > payload.txt\nexit 0\n', {
            mode: 0o755
          })
          const present = await run()
          expect(present.code, present.stderr).toBe(0)
          expect(present.stdout.trim()).toBe('{}')
          expect(readFileSync(join(root, 'payload.txt'), 'utf8')).toBe(input)
          rmSync(fixture)
          const missing = await run()
          expect(missing.timedOut).toBe(false)
          expect(missing.code).toBeGreaterThan(0)
          expect(missing.code).not.toBe(2)
          expect(missing.stdout.trim()).toBe('')
          expect(missing.stderr).not.toBe('')
        } finally {
          rmSync(root, { recursive: true, force: true })
        }
      }
    )
  }
})
