import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveStructuredAgentProgram } from './structured-agent-program'

let root: string
let options: { platform: NodeJS.Platform; pathEnv: string; homePath: string }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-structured-program-'))
  options = { platform: 'linux', pathEnv: join(root, 'bin'), homePath: root }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function stub(name: string): string {
  mkdirSync(join(root, 'bin'), { recursive: true })
  const file = join(root, 'bin', name)
  writeFileSync(file, '#!/bin/sh\nexit 0\n')
  chmodSync(file, 0o755)
  return file
}

const NOT_RUNNABLE = expect.objectContaining({
  name: 'AgentSessionPreSpawnError',
  reason: 'agentCommandNotRunnable'
})

describe.skipIf(process.platform === 'win32')('resolveStructuredAgentProgram', () => {
  it.each([undefined, null, '', '   '])('runs the stock CLI when the Command is %j', (value) => {
    const stock = stub('codex')
    expect(resolveStructuredAgentProgram('codex', value, options)).toBe(stock)
  })

  it('runs the configured program', () => {
    stub('claude')
    const configured = stub('claude-wrapper')
    expect(resolveStructuredAgentProgram('claude', 'claude-wrapper', options)).toBe(configured)
  })

  it('refuses a Command that names no runnable program, even with the stock CLI installed', () => {
    stub('claude')
    expect(() => resolveStructuredAgentProgram('claude', 'claude-missing', options)).toThrow(
      NOT_RUNNABLE
    )
    expect(() =>
      resolveStructuredAgentProgram('codex', join(root, 'missing', 'codex'), options)
    ).toThrow(NOT_RUNNABLE)
  })
})
