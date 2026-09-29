// Why a worker running `rmSync`: `fs.promises.rm` queues every entry of the tree on libuv's
// 4-thread pool, and every other async fs call in the process waits behind all of it. `rmSync` walks
// natively on the worker's own thread — no pool requests, and none of Electron's JS asar shim, which
// makes a JS-walked `rm` descend into a `*.asar` and strand the tree.

import type { RmOptions } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { PrioritySemaphore } from '../shared/priority-semaphore'

const REMOVE_TREE_WORKER_SOURCE = `const { workerData } = require('node:worker_threads')
require('node:fs').rmSync(workerData.path, workerData.options)`

// Why a cap: each worker is its own isolate (~10 MB), and history-tombstone drains start dozens of
// removals at once (64 simultaneous workers measured ~700 MB). Deletes are disk-bound, so running
// more than the old pool's four at a time buys nothing.
const MAX_CONCURRENT_TREE_REMOVALS = 4
const treeRemovalSlots = new PrioritySemaphore(MAX_CONCURRENT_TREE_REMOVALS)

/** Recursive remove that leaves the async fs thread pool free; rejects with the fs error (its `code` intact). */
export async function removeTreeOffThreadPool(
  targetPath: string,
  options: RmOptions
): Promise<void> {
  const release = await treeRemovalSlots.acquire(0)
  try {
    await runTreeRemovalWorker(targetPath, options)
  } finally {
    release()
  }
}

function runTreeRemovalWorker(targetPath: string, options: RmOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(REMOVE_TREE_WORKER_SOURCE, {
      eval: true,
      workerData: { path: targetPath, options }
    })
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
