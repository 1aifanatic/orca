import { parentPort } from 'node:worker_threads'
import type { OpenCodeSqliteWorkerRequest } from '../ai-vault/session-scanner-opencode-sqlite-worker-protocol'
import { handleOpenCodeSqliteRequest } from '../ai-vault/session-scanner-opencode-sqlite-dispatch'

if (!parentPort) {
  throw new Error('Foreign SQLite reader worker must run with a parent port.')
}
const port = parentPort

port.on('message', (request: OpenCodeSqliteWorkerRequest) => {
  void handleOpenCodeSqliteRequest(request).then((response) => {
    try {
      port.postMessage(response)
    } catch {
      // A non-cloneable result would otherwise post nothing and leave the client
      // waiting out its timeout; fail that request fast instead.
      port.postMessage({
        id: request.id,
        ok: false,
        error: 'Foreign SQLite reader result could not be serialized.'
      })
    }
  })
})
