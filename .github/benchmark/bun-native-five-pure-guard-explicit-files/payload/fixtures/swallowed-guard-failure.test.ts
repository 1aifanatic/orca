import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { it } from 'bun:test'
it('lets the canonical guard hook reject a swallowed refusal', () => {
  let caught = false
  try { rmSync(join(userInfo().homedir, '.codex', 'orca-never-created-' + randomUUID(), 'child'), { force: true }) }
  catch (error) { caught = error instanceof Error && error.message.includes('real-agent-home guard') }
  console.log('ORCA_NATIVE_SENTINEL ' + JSON.stringify({ kind: 'swallowed-refusal', caught, pid: process.pid }))
})
