import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Script } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import {
  instrumentWindowsTerminal,
  stageNativeInputDiagnostics
} from './ssh-windows-native-input-diagnostics.mjs'

const root = resolve(import.meta.dirname, '../..')
const source = readFileSync(join(root, 'node_modules/node-pty/lib/windowsTerminal.js'), 'utf8')
const privateDirs = []
const isolatedEnv = {
  GITHUB_ACTIONS: 'true',
  ORCA_ISOLATED_SSH_CI: '1',
  ORCA_BACKGROUND_LAUNCH: '1',
  ORCA_SSH_INPUT_DIAGNOSTICS: '1'
}

afterEach(() => {
  for (const dir of privateDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function virtualTerminal(instrumented, enabled = true, pipeError) {
  const logs = []
  const writes = []
  const callbacks = []
  class FakeAgent {
    innerPid = 42
    pty = 7
    fd = -1
    outSocket = new EventEmitter()
    inSocket = new EventEmitter()
    killed = false

    constructor() {
      this.inSocket.write = (data, callback) => {
        if (pipeError === 'throw') {
          throw Object.assign(new Error('fixture pipe'), { code: 'EPIPE' })
        }
        writes.push(data)
        if (callback) {
          callbacks.push(callback)
        }
        return false
      }
    }

    kill() {
      this.killed = true
    }
  }
  function Terminal() {
    EventEmitter.call(this)
  }
  Object.setPrototypeOf(Terminal.prototype, EventEmitter.prototype)
  Terminal.prototype._checkType = () => {}
  Terminal.prototype._parseEnv = () => []
  Terminal.prototype._forwardEvents = () => {}
  Terminal.prototype._close = function () {
    this._writable = false
  }
  const exports = {}
  new Script(instrumented ? instrumentWindowsTerminal(source) : source).runInNewContext({
    exports,
    Buffer,
    Date,
    console,
    process: {
      env: {},
      cwd: () => '/private-fixture',
      stderr: { write: (line) => logs.push(JSON.parse(line.split('ORCA_SSH_NATIVE_INPUT ')[1])) }
    },
    require: (name) => {
      if (name === './terminal') {
        return { Terminal, DEFAULT_COLS: 80, DEFAULT_ROWS: 24 }
      }
      if (name === './windowsPtyAgent') {
        return { WindowsPtyAgent: FakeAgent }
      }
      if (name === './utils') {
        return { assign: Object.assign }
      }
      throw new Error(`Unexpected fixture module ${name}`)
    }
  })
  const terminal = new exports.WindowsTerminal('cmd.exe', [], {
    env: enabled ? { ORCA_SSH_INPUT_DIAGNOSTICS: '1' } : {}
  })
  const ready = () => {
    terminal._socket.emit('ready_datapipe')
    terminal._socket.emit('data', 'fixture boot')
  }
  return { terminal, ready, writes, callbacks, logs }
}

describe('isolated Windows native input metadata', () => {
  it('preserves deferred input and exposes the exact pipe callback boundary', () => {
    const baseline = virtualTerminal(false)
    const diagnostic = virtualTerminal(true)
    for (const fixture of [baseline, diagnostic]) {
      fixture.terminal._write('private fixture input\r')
      expect(fixture.writes).toEqual([])
      fixture.ready()
      expect(fixture.writes).toEqual(['private fixture input\r'])
    }
    expect(diagnostic.logs.map((entry) => entry.phase)).toEqual([
      'constructed',
      'write-requested',
      'ready-datapipe',
      'first-output',
      'pipe-write-start',
      'pipe-write-returned'
    ])
    expect(diagnostic.logs.find((entry) => entry.phase === 'pipe-write-returned').accepted).toBe(
      false
    )
    diagnostic.callbacks[0]()
    expect(diagnostic.logs.at(-1)).toMatchObject({
      phase: 'pipe-write-settled',
      outcome: 'accepted',
      pid: 42,
      pty: 7
    })
    expect(JSON.stringify(diagnostic.logs)).not.toContain('private fixture input')
    expect(JSON.stringify(diagnostic.logs)).not.toContain('ORCA_SSH_INPUT_DIAGNOSTICS')
  })

  it('does not instrument an ordinary PTY or change its write arguments', () => {
    const fixture = virtualTerminal(true, false)
    fixture.ready()
    fixture.terminal._write('ordinary\r')
    expect(fixture.writes).toEqual(['ordinary\r'])
    expect(fixture.callbacks).toEqual([])
    expect(fixture.logs).toEqual([])
  })

  it('retains pipe errors and throws instead of turning them into acceptance', () => {
    const failed = virtualTerminal(true)
    failed.ready()
    failed.terminal._write('input\r')
    failed.callbacks[0](Object.assign(new Error('private error text'), { code: 'EPIPE' }))
    expect(failed.logs.at(-1)).toMatchObject({
      phase: 'pipe-write-settled',
      outcome: 'error',
      code: 'EPIPE'
    })
    expect(JSON.stringify(failed.logs)).not.toContain('private error text')
    const thrown = virtualTerminal(true, true, 'throw')
    thrown.ready()
    expect(() => thrown.terminal._write('input\r')).toThrow('fixture pipe')
    expect(thrown.logs.at(-1)).toMatchObject({ phase: 'pipe-write-threw', code: 'EPIPE' })
  })

  it('bounds native metadata even if the input path receives a flood', () => {
    const fixture = virtualTerminal(true)
    fixture.ready()
    for (let index = 0; index < 200; index++) {
      fixture.terminal._write('x')
    }
    expect(fixture.logs).toHaveLength(128)
    expect(fixture.writes).toHaveLength(200)
  })

  it('refuses unknown module bytes and every missing isolation guard before mutation', () => {
    expect(() => instrumentWindowsTerminal(`${source}\n`)).toThrow('unexpected staged')
    for (const key of Object.keys(isolatedEnv)) {
      expect(() =>
        stageNativeInputDiagnostics('/nonexistent', { ...isolatedEnv, [key]: '' })
      ).toThrow('isolated background CI')
    }
  })

  it('changes only the verified staged module and its own manifest leaf', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-native-input-staging-'))
    privateDirs.push(dir)
    const template = join(dir, 'out/orcad-template')
    const module = 'node_modules/node-pty/lib/windowsTerminal.js'
    mkdirSync(join(template, 'node_modules/node-pty/lib'), { recursive: true })
    writeFileSync(join(template, module), source)
    const original = {
      schemaVersion: 3,
      commonSha256: {
        [module]: '8247ecd69be8b18257050fb026b290024612c5ffc6d492ff1d46f81e613be2cf',
        unrelated: 'frozen'
      },
      targets: { 'win32-x64': { files: { native: 'frozen' } } }
    }
    writeFileSync(join(template, 'orcad-template.json'), JSON.stringify(original))
    const receipt = stageNativeInputDiagnostics(dir, isolatedEnv)
    const after = JSON.parse(readFileSync(join(template, 'orcad-template.json'), 'utf8'))
    expect(after.targets).toEqual(original.targets)
    expect(after.commonSha256.unrelated).toBe('frozen')
    expect(after.commonSha256[module]).toBe(receipt.stagedSha256)
    expect(receipt).toMatchObject({
      moduleReadbackExact: true,
      manifestReadbackExact: true,
      nativePayloadLogged: false
    })
    expect(
      readFileSync(
        join(dir, '.build/ssh-windows-host-receipts/native-input-original-windowsTerminal.js'),
        'utf8'
      )
    ).toBe(source)
    expect(() => stageNativeInputDiagnostics(dir, isolatedEnv)).toThrow('unexpected staged')
  })
})
