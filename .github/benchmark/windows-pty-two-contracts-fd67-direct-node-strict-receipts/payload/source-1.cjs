'use strict'

const assert = require('node:assert/strict')
const { writeSync } = require('node:fs')
const { dirname, resolve } = require('node:path')
const pty = require('node-pty')
const utilsPath = require.resolve('node-pty/lib/utils')
const loaded = require(utilsPath).loadNativeModule('conpty')
const native = loaded.module
const [operation, fence] = process.argv.slice(2)
assert.equal(process.platform, 'win32')
assert.ok(operation === 'kill' || operation === 'destroy')
assert.ok(fence === 'immediate' || fence === 'connected')
assert.equal(native.assignCurrentProcessToJob(), true, 'Host crash cleanup must own descendants')

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

async function exercise() {
  const { loadedStressInputHashes } = await import('./windows-pty-table-stress-observer.mjs')
  const addonPath = resolve(dirname(utilsPath), loaded.dir, 'conpty.node')
  writeSync(
    1,
    `${JSON.stringify({
      phase: 'inputs',
      node: process.version,
      inputs: loadedStressInputHashes(addonPath, require.resolve)
    })}\n`
  )
  const term = pty.spawn(
    process.execPath,
    ['-e', 'process.stdin.resume();setInterval(() => {}, 1000)'],
    {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      useConpty: true,
      useConptyDll: true,
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
    }
  )
  let dataCallbacks = 0
  let exitCallbacks = 0
  term.onData(() => {
    dataCallbacks += 1
  })
  term.onExit(() => {
    exitCallbacks += 1
  })
  const pid = term.pid
  function reportFence(stage) {
    writeSync(
      1,
      `${JSON.stringify({
        phase: 'fence',
        stage,
        operation,
        fence,
        pid,
        dataCallbacks,
        inputDestroyed: term._agent.inSocket.destroyed
      })}\n`
    )
  }
  assert.ok(Number.isInteger(pid) && pid > 0)
  assert.equal(alive(pid), true)
  assert.ok(native.listJobProcessIds(term._pty, pid)?.includes(pid))
  assert.equal(dataCallbacks, 0)
  term.write('queued input')

  const connected = new Promise((resolve, reject) => {
    // Observe the real forwarding connection; do not suppress or fabricate output.
    term._socket.once('ready_datapipe', () => {
      try {
        assert.equal(dataCallbacks, 0, 'The fence must precede delivered first data')
        reportFence('forwarding-connected')
        if (fence === 'connected') {
          assert.equal(alive(pid), true)
          assert.ok(native.listJobProcessIds(term._pty, pid)?.includes(pid))
          reportFence('before-public-teardown')
          term[operation]()
          reportFence('after-public-teardown')
        }
        // This is actual pipe retirement; old queued teardown leaves it open here.
        reportFence('pre-first-data-retirement')
        assert.equal(
          term._agent.inSocket.destroyed,
          true,
          'Public teardown must retire the actual input pipe at forwarding connection before first data'
        )
        term[operation]()
        term.write('retired input')
        term.resize(81, 24)
        term.clear()
        resolve()
      } catch (error) {
        reject(error)
      }
    })
  })
  if (fence === 'immediate') {
    reportFence('before-public-teardown')
    term[operation]()
    reportFence('after-public-teardown')
    term[operation]()
  }
  const deadline = Date.now() + 15_000
  let timeout
  try {
    await Promise.race([
      connected,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Forwarding connection did not arrive')),
          15_000
        )
      })
    ])
  } finally {
    clearTimeout(timeout)
  }
  while ((alive(pid) || exitCallbacks === 0) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(alive(pid), false, 'Public teardown must kill the real child')
  assert.equal(exitCallbacks, 1, 'Actual public exit must arrive exactly once')
  writeSync(1, `${JSON.stringify({ phase: 'complete', operation, fence, pid, exitCallbacks })}\n`)
}

exercise().catch((error) => {
  writeSync(2, `${error.stack}\n`)
  process.exitCode = 1
})
