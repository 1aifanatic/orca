import { DirectRpcClient } from '../transport/direct-rpc-client'
import { decodePairingUrl } from '../transport/pairing'
import type { RpcResponse } from '../transport/types'
import type { SendRequestOptions } from '../transport/rpc-client'
import { createBridgePortPair } from '../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import { useMobileSessionContentCreateActions } from '../session/use-mobile-session-content-create-actions'
import { mountFixture } from './rpc-recording/recorder-fixture-shape'
import { screenMount } from './rpc-recording/mounted-screen-tree'

type ObservedRequest = {
  method: string
  params: unknown
  options: SendRequestOptions | undefined
  ok: boolean
  runtimeId: string | undefined
}

class NoteProofDirectClient extends DirectRpcClient {
  readonly calls: ObservedRequest[] = []

  override async sendRequest(
    method: string,
    params?: unknown,
    options?: SendRequestOptions
  ): Promise<RpcResponse> {
    const reply = await super.sendRequest(method, params, options)
    this.calls.push({ method, params, options, ok: reply.ok, runtimeId: reply._meta?.runtimeId })
    return reply
  }
}

export async function createPairedMarkdownNote(
  pairingUrl: string,
  worktreeId: string,
  transport: 'native-direct' | 'web-bridge'
) {
  const offer = decodePairingUrl(pairingUrl)
  if (!offer) {
    throw new Error('The isolated host returned an unreadable pairing offer')
  }
  const direct = new NoteProofDirectClient(
    offer.endpoint,
    offer.deviceToken,
    offer.publicKeyB64,
    {}
  )
  let bridge: ReturnType<typeof createBridgePortPair> | undefined
  let screen: ReturnType<typeof screenMount> | undefined
  const timers: ReturnType<typeof setTimeout>[] = []
  try {
    await direct.sendRequest('status.get', undefined, { timeoutMs: 15_000 })
    if (transport === 'web-bridge') {
      bridge = createBridgePortPair({ rpc: direct, clientIdentity: offer.pairedDeviceId ?? null })
      await bridge.flush()
    }
    let creatingMarkdown = false
    let error = ''
    const scope = mountFixture<Parameters<typeof useMobileSessionContentCreateActions>[0]>({
      client: bridge?.client ?? direct,
      worktreeId,
      creatingMarkdown,
      setCreatingMarkdown: (value) => {
        creatingMarkdown = typeof value === 'function' ? value(creatingMarkdown) : value
      },
      setCreateError: (value) => {
        error = typeof value === 'function' ? value(error) : value
      },
      handleCreateBrowserRef: { current: async () => false },
      scheduleDelayedAction: (callback, delayMs) => timers.push(setTimeout(callback, delayMs)),
      fetchSessionTabs: async () => {},
      showToast: () => {}
    })
    const observed: { actions?: ReturnType<typeof useMobileSessionContentCreateActions> } = {}
    function Harness(): null {
      observed.actions = useMobileSessionContentCreateActions(scope)
      return null
    }
    screen = screenMount(
      () => createElement(Harness),
      () => {}
    )
    screen.mount()
    const actions = observed.actions
    if (!actions) {
      throw new Error(screen.crash() ?? 'The note-creation hook did not mount')
    }
    await actions.handleCreateMarkdownNote()
    return {
      creatingMarkdown,
      error,
      calls: direct.calls,
      bridgedMethods: bridge
        ?.readToShell()
        .flatMap((frame) => (frame.type === 'request' ? [frame.method] : []))
    }
  } finally {
    for (const timer of timers) {
      clearTimeout(timer)
    }
    screen?.unmount()
    bridge?.client.close()
    bridge?.host.dispose()
    direct.close()
  }
}
import { createElement } from 'react'
