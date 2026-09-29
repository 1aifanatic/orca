// Offline checks for the evidence oracle; runs anywhere, launches nothing.
import assert from 'node:assert/strict'
import {
  generationOfImage,
  isUnder,
  parseProcessTable,
  processIdentity,
  processVerdict,
  processesUnder
} from './windows-evidence.mjs'

const managed = 'C:\\Users\\r\\AppData\\Local\\Orca\\terminal-daemon-host\\managed-v1'
const hash = 'a'.repeat(64)
const created = '2026-09-29T10:00:00.1234567Z'
const table = parseProcessTable(
  JSON.stringify({
    rows: [
      {
        pid: 10,
        ppid: 1,
        name: 'bun-runtime.exe',
        exe: `${managed}\\bun-${hash}\\bun-runtime.exe`,
        created
      },
      {
        pid: 11,
        ppid: 10,
        name: 'powershell.exe',
        exe: 'C:\\Windows\\System32\\powershell.exe',
        created: ''
      }
    ]
  })
)

assert.equal(parseProcessTable('not json'), null, 'garbled snapshot is not evidence')
assert.equal(parseProcessTable('{"rows":[]}'), null, 'empty snapshot is not evidence')
assert.equal(
  parseProcessTable('{"rows":[{"pid":"x","name":"a"}]}'),
  null,
  'malformed row voids snapshot'
)

const daemon = processIdentity(table, 10)
assert.equal(processVerdict(table, daemon), 'live')
assert.equal(processVerdict(null, daemon), 'unverifiable', 'lost snapshot is never exited')
assert.equal(processVerdict(table, { pid: 99, created }), 'exited')
assert.equal(
  processVerdict(table, { pid: 10, created: '2026-09-29T09:00:00Z' }),
  'exited',
  'reused pid is a different process'
)
assert.equal(
  processVerdict(table, { pid: 11, created }),
  'unverifiable',
  'unreadable creation time is not a verdict'
)
assert.equal(processVerdict(table, null), 'unverifiable')
assert.equal(processIdentity(table, 11), null, 'identity requires creation time')

assert.equal(generationOfImage(`${managed}\\bun-${hash}\\bun-runtime.exe`, managed), `bun-${hash}`)
assert.equal(
  generationOfImage(
    `${managed.toUpperCase()}\\BUN-${hash.toUpperCase()}\\BUN-RUNTIME.EXE`,
    managed
  ),
  `bun-${hash}`
)
assert.equal(
  generationOfImage(`${managed}\\bun-${hash}.repair-2\\bun-runtime.exe`, managed),
  `bun-${hash}.repair-2`
)
assert.equal(generationOfImage(`${managed}\\.bun-staging-x\\bun-runtime.exe`, managed), null)
assert.equal(generationOfImage(`${managed}\\bun-${hash}\\conpty\\OpenConsole.exe`, managed), null)
assert.equal(
  generationOfImage(`${managed}-evil\\bun-${hash}\\bun-runtime.exe`, managed),
  null,
  'prefix sibling is outside'
)
assert.equal(
  generationOfImage('C:\\Program Files\\Orca\\resources\\cli-runtime\\bun-runtime.exe', managed),
  null
)

assert.ok(isUnder(`${managed}\\x`, `${managed}\\`))
assert.ok(!isUnder(managed, managed), 'the root itself is not inside itself')
assert.deepEqual(
  processesUnder(table, [managed]).map((row) => row.pid),
  [10]
)
console.log(
  'Evidence oracle: snapshot integrity, pid-reuse, unverifiable and generation parsing checks passed'
)
