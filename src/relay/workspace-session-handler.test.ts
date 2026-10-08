import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RelayDispatcher } from './dispatcher'
import { WorkspaceSessionHandler } from './workspace-session-handler'
import { encodeJsonRpcFrame, MessageType, type JsonRpcRequest } from './protocol'

function decodeJsonFrames(written: Buffer[]): unknown[] {
  return written
    .filter((buf) => buf[0] === MessageType.Regular)
    .map((buf) => {
      const len = buf.readUInt32BE(9)
      return JSON.parse(buf.subarray(13, 13 + len).toString('utf-8')) as unknown
    })
}

async function sendRequest(
  dispatcher: RelayDispatcher,
  method: string,
  params: Record<string, unknown>,
  id: number
): Promise<void> {
  const req: JsonRpcRequest = {
    jsonrpc: '2.0',
    id,
    method,
    params
  }
  dispatcher.feed(encodeJsonRpcFrame(req, id, 0))
  await Promise.resolve()
}

describe('WorkspaceSessionHandler', () => {
  let baseDir: string
  let dispatcher: RelayDispatcher
  let written: Buffer[]
  let handler: WorkspaceSessionHandler

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'orca-workspace-session-'))
    written = []
    dispatcher = new RelayDispatcher((data) => {
      written.push(Buffer.from(data))
    })
    handler = new WorkspaceSessionHandler(dispatcher, baseDir)
  })

  afterEach(() => {
    dispatcher.dispose()
    rmSync(baseDir, { recursive: true, force: true })
  })

  it('records no patch while the relay shuts down, and records again once it reopens', async () => {
    // A shutting-down relay kills its PTYs; the clients' retirement of those panes must not erase
    // the tabs they restore from this snapshot on reconnect.
    const patch = (id: number): Promise<void> =>
      sendRequest(
        dispatcher,
        'workspace.patch',
        {
          namespace: 'ns',
          baseRevision: 0,
          clientId: 'client-a',
          patch: { kind: 'replace-session', session: { tabsByWorktreePath: {} } }
        },
        id
      )
    const response = (id: number): unknown =>
      decodeJsonFrames(written).find(
        (frame) => typeof frame === 'object' && frame !== null && 'id' in frame && frame.id === id
      )

    handler.close()
    await patch(1)
    expect(response(1)).toMatchObject({ result: { ok: false, reason: 'unavailable' } })

    handler.reopen()
    await patch(2)
    expect(response(2)).toMatchObject({ result: { ok: true, snapshot: { revision: 1 } } })
  })

  it('stores snapshots atomically and rejects stale revisions', async () => {
    const session = {
      activeWorktreePath: '/repo/worktree',
      activeTabId: 'tab-1',
      tabsByWorktreePath: {
        '/repo/worktree': [{ id: 'tab-1', title: 'Terminal', worktreePath: '/repo/worktree' }]
      },
      terminalLayoutsByTabId: {}
    }

    await sendRequest(
      dispatcher,
      'workspace.patch',
      {
        namespace: 'ssh target/path',
        baseRevision: 0,
        clientId: 'client-a',
        patch: { kind: 'replace-session', session }
      },
      1
    )

    const frames = decodeJsonFrames(written)
    const response = frames.find((frame) => (frame as { id?: number }).id === 1) as {
      result: { ok: boolean; snapshot: { revision: number; session: unknown } }
    }
    expect(response.result.ok).toBe(true)
    expect(response.result.snapshot.revision).toBe(1)
    expect(response.result.snapshot.session).toEqual(session)
    expect(
      frames.some((frame) => (frame as { method?: string }).method === 'workspace.changed')
    ).toBe(true)

    written = []
    await sendRequest(
      dispatcher,
      'workspace.patch',
      {
        namespace: 'ssh target/path',
        baseRevision: 0,
        clientId: 'client-b',
        patch: { kind: 'replace-session', session: { ...session, activeTabId: 'tab-2' } }
      },
      2
    )

    const staleResponse = decodeJsonFrames(written).find(
      (frame) => (frame as { id?: number }).id === 2
    ) as { result: { ok: boolean; reason: string; snapshot: { revision: number } } }
    expect(staleResponse.result.ok).toBe(false)
    expect(staleResponse.result.reason).toBe('stale-revision')
    expect(staleResponse.result.snapshot.revision).toBe(1)
  })

  it('tracks presence per namespace', async () => {
    await sendRequest(
      dispatcher,
      'workspace.presence',
      {
        namespace: 'team',
        clientId: 'client-a',
        clientName: ' Laptop   A '
      },
      1
    )
    await sendRequest(
      dispatcher,
      'workspace.presence',
      {
        namespace: 'team',
        clientId: 'client-b',
        clientName: 'Laptop B'
      },
      2
    )

    const response = decodeJsonFrames(written).find(
      (frame) => (frame as { id?: number }).id === 2
    ) as {
      result: { clients: { clientId: string; name: string }[] }
    }
    expect(response.result.clients.map((client) => client.clientId).sort()).toEqual([
      'client-a',
      'client-b'
    ])
    expect(response.result.clients.find((client) => client.clientId === 'client-a')?.name).toBe(
      'Laptop A'
    )
  })
})
