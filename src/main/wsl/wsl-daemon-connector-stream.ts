import { Duplex, Readable, Writable } from 'node:stream'
import { spawnProcess, type ProcessSpec } from '../../shared/child-process/run-process'
import { WSL_DAEMON_CONNECTOR_READY } from './wsl-daemon-connector-script'

/** Closing this stream only retires its disposable connector, never the guest daemon. */
export function openWslDaemonConnectorStream(
  spec: ProcessSpec,
  signal: AbortSignal
): Promise<Duplex> {
  signal.throwIfAborted()
  const child = spawnProcess(spec)
  const stream = Duplex.fromWeb(
    { readable: Readable.toWeb(child.stdout), writable: Writable.toWeb(child.stdin) },
    { objectMode: false }
  )
  // A child can fail before the awaiting protocol consumer has installed its listener.
  stream.on('error', () => {})
  stream.once('close', () => child.kill())
  child.once('error', (error) => stream.destroy(error))
  child.once('close', () => stream.end())
  return new Promise((resolve, reject) => {
    let preamble = ''
    let settled = false
    const cleanup = () => {
      signal.removeEventListener('abort', abort)
      child.stderr.off('data', onStderr)
      child.off('error', fail)
      child.off('close', closed)
      child.stderr.resume()
    }
    const fail = (error: Error) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      stream.destroy()
      reject(error)
    }
    const closed = () => fail(new Error('WSL daemon connector closed before connection'))
    const abort = () =>
      fail(new Error('WSL daemon connector connection canceled', { cause: signal.reason }))
    const onStderr = (bytes: Buffer) => {
      preamble += bytes.toString('utf8')
      if (preamble.length > 4096) {
        fail(new Error('WSL daemon connector readiness output exceeded its limit'))
      } else if (preamble === WSL_DAEMON_CONNECTOR_READY) {
        settled = true
        cleanup()
        resolve(stream)
      }
    }
    child.stderr.on('data', onStderr)
    child.once('error', fail)
    child.once('close', closed)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
    }
  })
}
