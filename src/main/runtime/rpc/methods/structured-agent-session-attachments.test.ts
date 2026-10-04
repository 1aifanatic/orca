import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcResponse } from '../core'
import { RpcDispatcher } from '../dispatcher'
import {
  AGENT_SESSION_ATTACHMENTS_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from '../../../../shared/protocol-version'
import {
  AgentSessionAttachmentStore,
  setAgentSessionAttachmentStore
} from '../../../native-chat/agent-session-attachments/agent-session-attachment-store'
import { STRUCTURED_AGENT_SESSION_ATTACHMENT_METHODS } from './structured-agent-session-attachments'
import {
  clearStructuredHostStub,
  installStructuredHostStub,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

let root: string
let store: AgentSessionAttachmentStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-attachment-rpc-'))
  store = new AgentSessionAttachmentStore(join(root, 'agent-session-attachments'))
  setAgentSessionAttachmentStore(store)
  installStructuredHostStub()
})

afterEach(async () => {
  store.clearInFlightForTests()
  setAgentSessionAttachmentStore(null)
  clearStructuredHostStub()
  await rm(root, { recursive: true, force: true })
})

async function call(
  method: string,
  params: unknown,
  client: { clientId?: string; clientKind?: 'runtime' | 'mobile'; clientCapabilities?: string[] }
): Promise<RpcResponse> {
  const dispatcher = new RpcDispatcher({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the attachment methods read only the host-install hook and runtime id.
    runtime: {
      getRuntimeId: () => 'runtime-1',
      ensureStructuredAgentSessionHost: async () => {}
    } as unknown as OrcaRuntimeService,
    methods: STRUCTURED_AGENT_SESSION_ATTACHMENT_METHODS
  })
  const replies: RpcResponse[] = []
  await dispatcher.dispatchStreaming(
    { id: 'request-1', authToken: 'token', method, params },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher writes serialized RpcResponse frames.
    (raw) => replies.push(JSON.parse(raw) as RpcResponse),
    client
  )
  if (!replies[0]) {
    throw new Error(`no reply for ${method}`)
  }
  return replies[0]
}

function result<T>(response: RpcResponse): T {
  if (!response.ok) {
    throw new Error(`refused: ${JSON.stringify(response)}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each caller names the result shape its method returns.
  return response.result as T
}

const CLIENT_A = { ...STRUCTURED_CLIENT, clientId: 'client-a' }

describe('agentSessionAttachment.*', () => {
  it('is advertised, so a client can tell a host with the store from an older one', () => {
    expect(RUNTIME_CAPABILITIES).toContain(AGENT_SESSION_ATTACHMENTS_RUNTIME_CAPABILITY)
  })

  it('stores an upload for the chat and hands back the server path', async () => {
    const { uploadId } = result<{ uploadId: string }>(
      await call(
        'agentSessionAttachment.uploadStart',
        { sessionId: 'session-alpha', name: 'shot.png', byteLength: 3 },
        CLIENT_A
      )
    )
    result(
      await call(
        'agentSessionAttachment.uploadAppend',
        { uploadId, offset: 0, contentBase64: Buffer.from('png').toString('base64') },
        CLIENT_A
      )
    )
    const stored = result<{ path: string; name: string }>(
      await call('agentSessionAttachment.uploadCommit', { uploadId }, CLIENT_A)
    )
    expect(stored.name).toBe('shot.png')
    expect(stored.path.startsWith(store.sessionDirectory('session-alpha'))).toBe(true)
    expect(await readFile(stored.path, 'utf8')).toBe('png')

    const preview = await call('agentSessionAttachment.read', { path: stored.path }, CLIENT_A)
    expect(preview).toMatchObject({ ok: true, result: { isBinary: true, mimeType: 'image/png' } })
  })

  it('refuses a client that cannot read structured sessions', async () => {
    const response = await call(
      'agentSessionAttachment.uploadStart',
      { sessionId: 'session-alpha', name: 'shot.png', byteLength: 3 },
      { clientKind: 'runtime', clientCapabilities: [] }
    )
    expect(response).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('structured_agent_session_unsupported') }
    })
  })

  it('refuses a declared size over the attachment limit before storing anything', async () => {
    const response = await call(
      'agentSessionAttachment.uploadStart',
      { sessionId: 'session-alpha', name: 'big.bin', byteLength: 51 * 1024 * 1024 },
      CLIENT_A
    )
    expect(response.ok).toBe(false)
  })

  it("keeps one client's upload out of another's reach", async () => {
    const { uploadId } = result<{ uploadId: string }>(
      await call(
        'agentSessionAttachment.uploadStart',
        { sessionId: 'session-alpha', name: 'a.txt', byteLength: 1 },
        CLIENT_A
      )
    )
    const response = await call(
      'agentSessionAttachment.uploadCommit',
      { uploadId },
      {
        ...STRUCTURED_CLIENT,
        clientId: 'client-b'
      }
    )
    expect(response).toMatchObject({ ok: false })
    expect(store.isUploadInFlight(uploadId)).toBe(true)
  })
})
