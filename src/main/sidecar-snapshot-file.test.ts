import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as DurableFileWrite from './durable-file-write'

const durable = vi.hoisted(() => ({
  writeFileDurable: vi.fn(),
  writeFileProcessDurable: vi.fn()
}))

vi.mock('./durable-file-write', async (importOriginal) => {
  const actual = await importOriginal<typeof DurableFileWrite>()
  durable.writeFileDurable.mockImplementation(actual.writeFileDurable)
  durable.writeFileProcessDurable.mockImplementation(actual.writeFileProcessDurable)
  return { ...actual, ...durable }
})

import {
  _getSidecarSnapshotPendingFileCountForTests,
  readSidecarSnapshot,
  removeSidecarSnapshot,
  withSidecarSnapshotQueue,
  writeSidecarSnapshot
} from './sidecar-snapshot-file'

const roots: string[] = []

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-sidecar-snapshot-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('sidecar snapshot queues', () => {
  it('releases completed per-file queue entries', async () => {
    await Promise.all(
      Array.from({ length: 600 }, (_, index) =>
        withSidecarSnapshotQueue(`snapshot-${index}`, async () => undefined)
      )
    )

    await Promise.resolve()
    expect(_getSidecarSnapshotPendingFileCountForTests()).toBe(0)
  })
})

describe('sidecar snapshot writes', () => {
  it('flushes to disk by default, as every existing caller expects', async () => {
    const file = join(await freshRoot(), 'snapshot.json')

    await writeSidecarSnapshot(file, { a: 1 })

    expect(durable.writeFileDurable).toHaveBeenCalledOnce()
    expect(durable.writeFileProcessDurable).not.toHaveBeenCalled()
    expect(await readSidecarSnapshot(file)).toEqual({ a: 1 })
  })

  it("skips the disk flush only when asked for 'process' durability", async () => {
    const file = join(await freshRoot(), 'snapshot.json')

    await writeSidecarSnapshot(file, { a: 1 }, { durability: 'process' })

    expect(durable.writeFileProcessDurable).toHaveBeenCalledOnce()
    expect(durable.writeFileDurable).not.toHaveBeenCalled()
    expect(await readSidecarSnapshot(file)).toEqual({ a: 1 })
  })

  it('removes a snapshot, and treats a missing one as removed', async () => {
    const root = await freshRoot()
    const file = join(root, 'snapshot.json')
    await writeSidecarSnapshot(file, { a: 1 }, { durability: 'process' })

    await withSidecarSnapshotQueue(file, () => removeSidecarSnapshot(file))
    await expect(removeSidecarSnapshot(file)).resolves.toBeUndefined()

    expect(await readdir(root)).toEqual([])
  })
})
