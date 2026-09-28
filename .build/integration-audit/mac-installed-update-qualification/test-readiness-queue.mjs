import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createReadinessQueue } from './readiness-queue.mjs'
const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
let cancelled = false
const queue = createReadinessQueue(child, { cancelled: () => cancelled })
const first = queue.next(500)
child.stdout.write('{"type":"orca_server_')
child.stdout.write('ready","version":"A"}\n')
assert.equal((await first).version, 'A')
child.stdout.write('{"type":"orca_server_ready","version":"B"}\n')
assert.equal((await queue.next(500)).version, 'B')
const third = queue.next(500); cancelled = true
await assert.rejects(third, /cancelled/)
const bounded = new EventEmitter(); bounded.stdout = new PassThrough(); bounded.stderr = new PassThrough()
const limited = createReadinessQueue(bounded, { maxBytes: 10 })
const overflow = limited.next(500); bounded.stdout.write('12345678901')
await assert.rejects(overflow, /output limit/)
console.log('Replacement readiness queue: split frames, queued replacement, cancellation and output cap passed')
