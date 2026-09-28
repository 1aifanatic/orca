import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { removeTreeSync } from '../shared/windows-transient-lock-removal'
import { removeHostTree } from './host-tree-removal'

const roots: string[] = []

afterAll(() => {
  for (const root of roots) {
    removeTreeSync(root)
  }
})

function buildTree(root: string, directories: number, filesPerDirectory: number): string {
  const target = join(root, 'wt-1700000000000-abcdef01')
  for (let d = 0; d < directories; d++) {
    const directory = join(target, `pkg-${d}`, 'lib')
    mkdirSync(directory, { recursive: true })
    for (let f = 0; f < filesPerDirectory; f++) {
      writeFileSync(join(directory, `${f}.js`), 'x')
    }
  }
  return target
}

describe('removeHostTree', () => {
  it('removes the whole tree, and treats an already-missing tree as removed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-host-tree-'))
    roots.push(root)
    const target = buildTree(root, 3, 3)

    await removeHostTree(target)

    expect(existsSync(target)).toBe(false)
    expect(existsSync(root)).toBe(true)
    await expect(removeHostTree(target)).resolves.toBeUndefined()
  })

  // A pool-backed recursive rm queued every entry ahead of this chain, so the agent-session store
  // (and every other async fs caller) waited for the entire tree.
  it('leaves the async fs pool free for other callers while a large tree is deleted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-host-tree-'))
    roots.push(root)
    const target = buildTree(root, 40, 50)
    let removalSettled = false
    const removal = removeHostTree(target).finally(() => {
      removalSettled = true
    })

    for (let i = 0; i < 20; i++) {
      await stat(root)
    }
    const chainFinishedFirst = !removalSettled

    await removal
    expect(chainFinishedFirst).toBe(true)
    expect(existsSync(target)).toBe(false)
  }, 60_000)
})
