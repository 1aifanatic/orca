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
type Event = { data: string } | { resizeTo: number } | { appliedSize: { cols: number; rows: number } }
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
      else if ('data' in event) emulator.writeSync(event.data)
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
  const dimensionLog = join(directory, 'dimensions.log')
  // `dimensions` holds the cached width (SIGWINCH-refreshed) and a fresh GetConsoleScreenBufferInfo read.
  // Raw stdin like a real TUI: without it libuv relies on EVENT_CONSOLE_LAYOUT, which never fired under SSH ConPTY.
  const source = `const fs=require('node:fs');const tty=require('node:tty');process.stdout.write('\\x1bc');let i=0;const timer=setInterval(()=>{process.stdout.write(${JSON.stringify(korean)}+'\\r\\n'+${JSON.stringify(latin)}+'\\r\\n');if(++i===8){clearInterval(timer);process.stdout.write('',()=>fs.writeFileSync(${JSON.stringify(settled)},''));}},25);let winch=0,last='',beat=0,inputs=0;process.on('SIGWINCH',()=>winch++);process.stdin.setRawMode(true);process.stdin.on('data',()=>inputs++);process.stdin.resume();const log=(extra)=>fs.appendFileSync(${JSON.stringify(dimensionLog)},JSON.stringify({t:Date.now(),pid:process.pid,...extra})+'\\n');log({start:true});setInterval(()=>{const cached=process.stdout.columns;let fresh=null;try{fresh=new tty.WriteStream(1).columns}catch(e){fresh=String(e)}fs.writeFileSync(${JSON.stringify(dimensions)},cached+'/'+fresh);const key=cached+'/'+fresh+'/'+winch+'/'+inputs;if(key!==last||++beat%50===0){last=key;log({cached,fresh,winch,inputs})}},20);process.on('exit',(code)=>log({exit:code}));setTimeout(()=>process.exit(0),45000);`
  writeFileSync(script, source)
  const events: Event[] = []
  const timeline: { t: number; mark: string; detail?: unknown }[] = []
  const mark = (name: string, detail?: unknown) => timeline.push({ t: Date.now(), mark: name, detail })
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
      mark('data', Buffer.byteLength(message.data))
    }
  })
  const quiet = async (cols: number) => {
    const deadline = performance.now() + 15000
    while (performance.now() < deadline) {
      assert(!overflow, 'Repaint event budget exceeded')
      if (
        existsSync(settled) &&
        existsSync(dimensions) &&
        readFileSync(dimensions, 'utf8') === `${cols}/${cols}` &&
        performance.now() - lastOutput > 250
      )
        return
      await delay(25)
    }
    mark('settle-timeout', {
      cols,
      dimensions: existsSync(dimensions) ? readFileSync(dimensions, 'utf8') : null
    })
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
    mark('command-sent')
    await quiet(40)
    mark('settled', 40)
    const initial = assertEight(events)
    mark('observe-provider-start')
    const provider = await options.observeProvider()
    mark('observe-provider-end')
    const settledWidths: { cols: number; lines: string[] }[] = [{ cols: 40, lines: initial }]
    for (const cols of [31, 47]) {
      events.push({ resizeTo: cols })
      options.mux.notify('pty.resize', { id, cols, rows: 12 })
      mark('resize-sent', cols)
      const applied = await options.mux.request('pty.getSize', { id })
      assert(
        applied &&
          typeof applied === 'object' &&
          'cols' in applied &&
          'rows' in applied &&
          typeof applied.cols === 'number' &&
          typeof applied.rows === 'number',
        'pty.getSize returned an invalid applied-size response'
      )
      events.push({ appliedSize: { cols: applied.cols, rows: applied.rows } })
      mark('applied-size', { cols: applied.cols, rows: applied.rows })
      // Give the remote resize time to arrive before measuring output quiescence.
      await delay(350)
      await quiet(cols)
      mark('settled', cols)
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
      JSON.stringify(
        {
          directory,
          terminalId: id,
          events,
          timeline,
          dimensionLog: existsSync(dimensionLog)
            ? readFileSync(dimensionLog, 'utf8').split('\n').filter(Boolean)
            : []
        },
        null,
        2
      )
    )
  }
}
