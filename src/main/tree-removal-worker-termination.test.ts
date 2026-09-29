import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { removeTreeSync } from '../shared/windows-transient-lock-removal'
import { startTreeRemovalWorker } from './tree-removal-worker'

const roots: string[] = []

afterAll(() => {
  for (const root of roots) {
    removeTreeSync(root)
  }
})

describe('tree removal worker termination', () => {
  // Quitting joins every worker thread; a delete that ignored termination kept the app alive after
  // its windows closed until the whole worktree was gone.
  it('stops partway through a tree when terminated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-tree-removal-termination-'))
    roots.push(root)
    const target = join(root, 'tree')
    const directories = 100
    for (let d = 0; d < directories; d++) {
      const directory = childPath(target, d)
      mkdirSync(directory, { recursive: true })
      for (let f = 0; f < 30; f++) {
        writeFileSync(join(directory, `${f}.js`), 'x')
      }
    }

    const worker = startTreeRemovalWorker(target, { recursive: true, force: true })
    const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()))
    const deadline = Date.now() + 30_000
    // Wait for deletion to start so termination lands mid-walk rather than before it.
    while (Array.from({ length: directories }).every((_, d) => existsSync(childPath(target, d)))) {
      if (Date.now() > deadline) {
        throw new Error('tree removal never started')
      }
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    await worker.terminate()
    await exited

    expect(existsSync(target)).toBe(true)
  }, 60_000)
})

function childPath(target: string, index: number): string {
  return join(target, `pkg-${String(index).padStart(3, '0')}`)
}
