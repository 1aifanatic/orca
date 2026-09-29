import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import { readWrappedLineGlyphs } from '../daemon/__fixtures__/terminal-wide-cell-grid'
import type { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { powerShellLiteral } from './ssh-remote-powershell'

// Exact fixture and oracle from pty-repaint-wide-char-buffer.bun.test.ts.
const korean = '안녕하세요 오르카 테스트입니다. 결론부터 말씀드리면 시각적 피로도'
const latin = 'roadmap/complete-overhaul-backlog-history.md (1.75) R-08)'
type Event = { data: string } | { resizeTo: number }
class ProbeEmulator extends HeadlessEmulator {
  lines(): string[] {
    return readWrappedLineGlyphs(this.terminal).filter((line) => line.length > 0)
  }
}
function assertEight(events: Event[]): string[] {
  const emulator = new ProbeEmulator({ cols: 40, rows: 12 })
  try {
    for (const event of events) {
      if ('resizeTo' in event) emulator.resize(event.resizeTo, 12)
      else emulator.writeSync(event.data)
    }
    const lines = emulator.lines()
    const ko = korean.replace(/\s+/g, '')
    const la = latin.replace(/\s+/g, '')
    assert.equal(
      lines.filter((line) => line === ko).length,
      8,
      'all eight Korean rows must survive'
    )
    assert.equal(lines.filter((line) => line === la).length, 8, 'all eight Latin rows must survive')
    assert.deepEqual(
      lines.filter((line) => line !== ko && line !== la),
      [],
      'unexpected fixture rows'
    )
    return lines
  } finally {
    emulator.dispose()
  }
}
export async function proveRepaint(options: {
  mux: SshChannelMultiplexer
  runtime: string
  fixtureParent: string
  receiptPath: string
  ownTerminal(id: string): void
  ownDirectory(directory: string): void
  observeProvider(): Promise<unknown>
}): Promise<Record<string, unknown>> {
  const directory = join(options.fixtureParent, `provider-probe-${randomUUID()}`)
  mkdirSync(directory)
  options.ownDirectory(directory)
  const script = join(directory, 'repaint.cjs')
  const settled = join(directory, 'settled')
  const dimensions = join(directory, 'dimensions')
  const source = `const fs=require('node:fs');process.stdout.write('\\x1bc');let i=0;const timer=setInterval(()=>{process.stdout.write(${JSON.stringify(korean)}+'\\r\\n'+${JSON.stringify(latin)}+'\\r\\n');if(++i===8){clearInterval(timer);process.stdout.write('',()=>fs.writeFileSync(${JSON.stringify(settled)},''));}},25);setInterval(()=>fs.writeFileSync(${JSON.stringify(dimensions)},String(process.stdout.columns)),20);setTimeout(()=>process.exit(0),45000);`
  writeFileSync(script, source)
  const events: Event[] = []
  let id = ''
  let lastOutput = performance.now()
  let overflow = false
  let bytes = 0
  const subscription = options.mux.onNotificationByMethod('pty.data', (message) => {
    if (message.id === id && typeof message.data === 'string') {
      bytes += Buffer.byteLength(message.data)
      if (events.length > 10000 || bytes > 1048576) {
        overflow = true
        return
      }
      events.push({ data: message.data })
      lastOutput = performance.now()
    }
  })
  const quiet = async (cols: number) => {
    const deadline = performance.now() + 15000
    while (performance.now() < deadline) {
      assert(!overflow, 'Repaint event budget exceeded')
      if (
        existsSync(settled) &&
        existsSync(dimensions) &&
        readFileSync(dimensions, 'utf8') === String(cols) &&
        performance.now() - lastOutput > 250
      )
        return
      await delay(25)
    }
    throw new Error('Fixture did not settle')
  }
  try {
    const spawned: unknown = await options.mux.request('pty.spawn', {
      cols: 40,
      rows: 12,
      shellOverride: 'powershell.exe'
    })
    assert(
      spawned && typeof spawned === 'object' && 'id' in spawned && typeof spawned.id === 'string'
    )
    id = spawned.id
    options.ownTerminal(id)
    options.mux.notify('pty.data', {
      id,
      data: `& ${powerShellLiteral(options.runtime)} --no-env-file --config=NUL --no-install ${powerShellLiteral(script)}\r`
    })
    await quiet(40)
    const initial = assertEight(events)
    const provider = await options.observeProvider()
    const settledWidths: { cols: number; lines: string[] }[] = [{ cols: 40, lines: initial }]
    for (const cols of [31, 47]) {
      events.push({ resizeTo: cols })
      options.mux.notify('pty.resize', { id, cols, rows: 12 })
      // Give the remote resize time to arrive before measuring output quiescence.
      await delay(350)
      await quiet(cols)
      settledWidths.push({ cols, lines: assertEight(events) })
    }
    const final = assertEight(events)
    return {
      initial,
      final,
      resizeOrder: [40, 31, 47],
      settledWidths,
      provider,
      fixtureDirectory: directory,
      koreanRows: 8,
      latinRows: 8,
      exactRowsOnly: true
    }
  } finally {
    subscription()
    writeFileSync(
      options.receiptPath,
      JSON.stringify({ directory, terminalId: id, events }, null, 2)
    )
  }
}
