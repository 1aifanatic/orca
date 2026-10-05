import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getCodexHookStatus } from './codex-hook-status'
import { buildCodexManagedHook } from './codex-hook-definition'
import { upsertHookTrustEntries } from './config-toml-trust'

const COMMAND = '/home/u/.orca/agent-hooks/codex-hook.sh'
let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-codex-hook-status-'))
  writeFileSync(
    join(home, 'hooks.json'),
    JSON.stringify({ hooks: { Stop: [{ hooks: [buildCodexManagedHook(COMMAND, 'Stop')] }] } })
  )
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function status(answer: Parameters<typeof getCodexHookStatus>[0]['answer']) {
  return getCodexHookStatus({
    hooksJsonPath: join(home, 'hooks.json'),
    tomlPath: join(home, 'config.toml'),
    keySourcePaths: ['/other/spelling/hooks.json', join(home, 'hooks.json')],
    command: COMMAND,
    answer
  })
}

function approve(hash: string, enabled = true): void {
  upsertHookTrustEntries(join(home, 'config.toml'), [
    {
      sourcePath: join(home, 'hooks.json'),
      eventLabel: 'stop',
      groupIndex: 0,
      handlerIndex: 0,
      command: COMMAND,
      trustedHash: hash,
      enabled
    }
  ])
}

describe('getCodexHookStatus', () => {
  it('reads installed only when the entry holds Codex hash under one of its spellings, enabled', () => {
    const answer = {
      codexVersion: 'codex-cli 0.150.1',
      hashes: { stop: 'sha256:a' },
      failure: null
    }
    approve('sha256:stale')
    expect(status(answer).state).toBe('partial')
    approve('sha256:a', false)
    expect(status(answer).state).toBe('partial')
    approve('sha256:a')
    expect(status(answer)).toMatchObject({ state: 'installed', detail: null })
  })

  it("says an installed entry's approval is not verified yet, not that nothing is installed", () => {
    expect(status(null)).toMatchObject({
      state: 'partial',
      detail: expect.stringContaining('approval is not verified yet')
    })
  })
})
