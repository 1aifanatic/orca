import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { wrapRuntimeHomeHookCommand } from './runtime-home-hook-command'
import { buildHookProcessCapture } from './hook-process-capture'
import { readAgentProcessIdentity } from '../../shared/agent-process-presence'
import { probeAgentProcessPresence } from '../../shared/agent-process-presence-probe'

describe('Claude outer hook process capture', () => {
  it.skipIf(process.platform === 'win32')(
    'captures the parent before the managed script shell, under an empty environment',
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'orca-presence-hook-'))
      try {
        const dir = join(home, '.orca', 'agent-hooks')
        await mkdir(dir, { recursive: true })
        await writeFile(
          join(dir, 'claude-hook.sh'),
          ['#!/bin/sh', ...buildHookProcessCapture(), 'printf "%s" "$orca_agent_process"'].join(
            '\n'
          ),
          { mode: 0o700 }
        )
        const result = await runProcess({
          program: '/usr/bin/env',
          args: [
            '-i',
            `HOME=${home}`,
            'PATH=/usr/bin:/bin',
            '/bin/sh',
            '-c',
            wrapRuntimeHomeHookCommand('claude-hook')
          ],
          timeoutMs: 5000
        })
        expect(result.code).toBe(0)
        const identity = readAgentProcessIdentity(result.stdout)
        expect(identity?.pid).toBe(process.pid)
        expect(await probeAgentProcessPresence(identity)).toBe('live')
      } finally {
        await rm(home, { recursive: true, force: true })
      }
    }
  )
})
