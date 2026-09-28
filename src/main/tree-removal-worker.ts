// Why a worker running `rmSync`: `fs.promises.rm` queues every entry of the tree on libuv's
// 4-thread pool, and every other async fs call in the process waits behind all of it. `rmSync` walks
// natively on the worker's own thread — no pool requests, and none of Electron's JS asar shim, which
// makes a JS-walked `rm` descend into a `*.asar` and strand the tree.

import type { RmOptions } from 'node:fs'
import { Worker } from 'node:worker_threads'

const REMOVE_TREE_WORKER_SOURCE = `const { workerData } = require('node:worker_threads')
require('node:fs').rmSync(workerData.path, workerData.options)`

/** Recursive remove that leaves the async fs thread pool free; rejects with the fs error (its `code` intact). */
export function removeTreeOffThreadPool(targetPath: string, options: RmOptions): Promise<void> {
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
