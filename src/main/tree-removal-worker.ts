// Why a worker running `rmSync`: `fs.promises.rm` queues every entry of the tree on libuv's
// 4-thread pool, and every other async fs call in the process waits behind all of it. Sync calls on
// the worker's own thread make no pool requests.
// Why walk in JS with one `rmSync` per entry rather than one native `rmSync` of the root: quitting
// joins every worker thread, and termination only lands between JS calls, so a single native call
// on a worktree held the quitting app alive until the whole tree was gone.
// Why `noAsar` (this worker's own `process`): Electron's shim reads a `*.asar` as a directory, which
// strands the tree.

import type { RmOptions } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { PrioritySemaphore } from '../shared/priority-semaphore'

const REMOVE_TREE_WORKER_SOURCE = `const { workerData } = require('node:worker_threads')
const { lstatSync, readdirSync, rmSync } = require('node:fs')
const { sep } = require('node:path')
process.noAsar = true
function remove(target, isDirectory) {
  if (isDirectory) {
    let entries = []
    try {
      entries = readdirSync(target, { withFileTypes: true })
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
    }
    for (const entry of entries) remove(target + sep + entry.name, entry.isDirectory())
  }
  rmSync(target, workerData.options)
}
let isDirectory = false
try {
  isDirectory = lstatSync(workerData.path).isDirectory()
} catch {}
remove(workerData.path, isDirectory)`

/** `background`: fire-and-forget bulk deletes (worktree trash, history tombstones). `interactive`: a caller awaits it. */
export type TreeRemovalLane = 'interactive' | 'background'

// Why only background is capped: each worker is its own isolate (~10 MB) and history-tombstone
// drains start dozens at once (64 simultaneous measured ~700 MB), while an awaited delete must never
// queue behind a multi-minute trash delete. Awaited deletes are bounded by the callers awaiting them.
const MAX_CONCURRENT_BACKGROUND_TREE_REMOVALS = 4
const backgroundTreeRemovalSlots = new PrioritySemaphore(MAX_CONCURRENT_BACKGROUND_TREE_REMOVALS)

/** Recursive remove that leaves the async fs thread pool free; rejects with the fs error (its `code` intact). */
export async function removeTreeOffThreadPool(
  targetPath: string,
  options: RmOptions,
  lane: TreeRemovalLane
): Promise<void> {
  if (lane === 'interactive') {
    return runTreeRemovalWorker(targetPath, options)
  }
  const release = await backgroundTreeRemovalSlots.acquire(0)
  try {
    await runTreeRemovalWorker(targetPath, options)
  } finally {
    release()
  }
}

/** Exported for the termination test; production callers go through `removeTreeOffThreadPool`. */
export function startTreeRemovalWorker(targetPath: string, options: RmOptions): Worker {
  return new Worker(REMOVE_TREE_WORKER_SOURCE, {
    eval: true,
    workerData: { path: targetPath, options }
  })
}

function runTreeRemovalWorker(targetPath: string, options: RmOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = startTreeRemovalWorker(targetPath, options)
    let failure: unknown = null
    worker.once('error', (error) => {
      failure = error
    })
    worker.once('exit', (code) => {
      if (failure) {
        reject(failure)
      } else if (code !== 0) {
        reject(new Error(`Tree removal worker exited with code ${code}`))
      } else {
        resolve()
      }
    })
  })
}
