import { existsSync } from 'node:fs'

const mode = process.argv[2]
const validProvider = process.argv[3]

function rejectedCreation() {
  let terminal
  try {
    terminal = new Bun.Terminal({ cols: 40, rows: 10, data() {} })
    return { rejected: false }
  } catch (error) {
    return { rejected: true, error: String(error) }
  } finally {
    terminal?.close()
  }
}

async function terminalCycle(index) {
  let output = ''
  let answered = false
  const marker = `PROVIDER_CYCLE_${index}`
  let markReady
  const ready = new Promise((resolve) => { markReady = resolve })
  const terminal = new Bun.Terminal({
    cols: 40,
    rows: 10,
    data(terminal, bytes) {
      output += Buffer.from(bytes).toString('utf8')
      if (output.includes(marker)) markReady()
      if (!answered && (output.includes('\x1b[c') || output.includes('\x1b[0c'))) {
        answered = true
        terminal.write('\x1b[?1;2c')
      }
    }
  })
  let child
  let timer
  try {
    child = Bun.spawn([
      process.execPath,
      '-e',
      `process.stdout.write(${JSON.stringify(`${marker}\r\n`)});setTimeout(()=>process.exit(0),75)`
    ], { terminal, env: process.env })
    terminal.resize(52, 14)
    const exitCode = await Promise.race([
      Promise.all([child.exited, ready]).then(([code]) => code),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Cycle ${index} stalled`)), 5_000)
      })
    ])
    return { exitCode, markerSeen: output.includes(marker), answered }
  } finally {
    clearTimeout(timer)
    child?.kill()
    terminal.close()
    if (child) await child.exited
  }
}

if (process.platform !== 'win32') throw new Error('Windows qualification only')
let result
if (mode === 'reject') {
  result = rejectedCreation()
} else if (mode === 'set-before-first-terminal') {
  const inherited = process.env.BUN_CONPTY_LIBRARY ?? null
  process.env.BUN_CONPTY_LIBRARY = validProvider
  result = { inherited, cycle: await terminalCycle(0) }
} else if (mode === 'cached-failure') {
  const first = rejectedCreation()
  process.env.BUN_CONPTY_LIBRARY = validProvider
  result = { first, second: rejectedCreation() }
} else if (mode === 'cached-success') {
  if (!existsSync(validProvider)) throw new Error('Missing qualified provider')
  const cycles = [await terminalCycle(0)]
  // A later invalid selector must not replace the already-loaded provider or its close callbacks.
  process.env.BUN_CONPTY_LIBRARY = 'not-an-absolute-provider.dll'
  for (let index = 1; index < 8; index++) cycles.push(await terminalCycle(index))
  result = { cycles }
} else {
  throw new Error(`Unknown qualification mode: ${mode}`)
}
console.log(JSON.stringify(result))
