import { describe, expect, it } from 'vitest'
import { runProcess } from './child-process/run-process'
import { readAgentProcess } from './agent-process-presence-probe'
import { processTableEnv } from './process-table-snapshot-reader'

describe.runIf(process.platform === 'darwin')('Darwin process start clock', () => {
  it('prints the same instant for the table and the identity read, whatever the user locale and zone', async () => {
    const table = await runProcess({
      program: 'ps',
      args: ['-p', String(process.pid), '-o', 'lstart='],
      env: processTableEnv({ ...process.env, LC_ALL: 'zh_CN.UTF-8', TZ: 'Asia/Shanghai' }),
      timeoutMs: 5_000,
      maxOutputBytes: 4096
    })
    const identity = await readAgentProcess(process.pid)
    expect(identity.verdict).toBe('live')
    const tableAt = Date.parse(`${table.stdout.trim()} UTC`)
    expect(Number.isFinite(tableAt)).toBe(true)
    expect(tableAt).toBe(
      identity.verdict === 'live' ? Date.parse(`${identity.startTime} UTC`) : Number.NaN
    )
  })
})
