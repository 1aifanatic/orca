// A real child process (plain Node, never an agent CLI) behind the ACP child wrapper.

import { describe, expect, it } from 'vitest'
import { spawnAcpStructuredChild } from './acp-structured-child'

// Echoes stdin lines back, writes to stderr, and exits once stdin closes.
const ECHO = [
  "process.stderr.write('agent log\\n')",
  "process.stdin.on('data', (chunk) => process.stdout.write(chunk))",
  "process.stdin.on('end', () => process.exit(0))"
].join(';')

function launch(script: string) {
  return { command: process.execPath, args: ['-e', script], cwd: process.cwd() }
}

describe('ACP structured child', () => {
  it('carries stdio, keeps the stderr tail, and proves its exit on close', async () => {
    const child = spawnAcpStructuredChild(launch(ECHO))
    await child.spawned
    expect(child.pid).toEqual(expect.any(Number))
    const echoed = new Promise<string>((resolve) =>
      child.stdout.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')))
    )
    child.stdin.write('{"jsonrpc":"2.0"}\n')
    expect(await echoed).toBe('{"jsonrpc":"2.0"}\n')
    let exits = 0
    child.onExit(() => {
      exits += 1
    })
    await expect(child.close()).resolves.toBe(true)
    expect(child.exited).toBe(true)
    expect(exits).toBe(1)
    expect(child.stderrTail()).toContain('agent log')
    await expect(child.close()).resolves.toBe(true)
  }, 20_000)

  it('reports an exit nobody asked for', async () => {
    const child = spawnAcpStructuredChild(launch('process.exit(3)'))
    await new Promise<void>((resolve) => child.onExit(resolve))
    expect(child.exited).toBe(true)
  }, 20_000)

  // POSIX starts a supervisor that then fails to exec; Windows starts nothing at all.
  it('ends a binary that cannot start, with or without a process to name', async () => {
    const child = spawnAcpStructuredChild({
      command: '/nonexistent/orca-acp-test-binary',
      args: [],
      cwd: process.cwd()
    })
    await child.spawned
    if (child.pid !== undefined) {
      await new Promise<void>((resolve) => child.onExit(resolve))
      expect(child.exited).toBe(true)
    }
    await expect(child.close()).resolves.toBe(true)
  }, 20_000)
})
