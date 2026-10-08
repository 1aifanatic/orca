import WebSocket from 'ws'
import type { PairingOffer } from './pairing'
import type { RuntimeCapability } from './protocol-version'
import {
  decrypt,
  decryptBytes,
  deriveSharedKey,
  encrypt,
  generateKeyPair,
  publicKeyFromBase64,
  publicKeyToBase64
} from './e2ee-crypto'
import {
  classifyRemoteRuntimeReadyFrame,
  formatRemoteRuntimeCloseMessage,
  parseRemoteRuntimeAuthenticatedFrame
} from './remote-runtime-client-handshake'
import { RemoteRuntimeClientError } from './remote-runtime-client-error'
import {
  remoteRuntimeConnectFailureMessage,
  remoteRuntimeConnectOptions
} from './remote-runtime-connect-bound'
import {
  REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES,
  serializeRemoteRuntimePayload
} from './remote-runtime-memory-limits'
import { closeRemoteRuntimeSocket } from './remote-runtime-socket-close'
import {
  startRemoteRuntimeSocketLiveness,
  type RemoteRuntimeSocketLivenessOptions
} from './remote-runtime-socket-liveness'
import { RemoteRuntimeSubscriptionOutbound } from './remote-runtime-subscription-outbound'

export type RemoteRuntimePassthroughSocket = {
  /** Queues one plaintext RPC frame; false when the socket can no longer carry it. */
  send: (plaintext: string) => boolean
  close: () => void
}

export type RemoteRuntimePassthroughCallbacks = {
  onText: (plaintext: string) => void
  onBinary: (bytes: Uint8Array<ArrayBufferLike>) => void
  /** Called once when an open socket ends for any reason other than `close()`. */
  onClose: (error: RemoteRuntimeClientError) => void
}

/**
 * An authenticated E2EE socket that carries any number of requests and streams and hands every
 * decrypted frame back untouched. Why not the subscription transport: it owns one request id per
 * socket and fails on any other, while a relay forwards whatever its client multiplexes.
 */
export function openRemoteRuntimePassthroughSocket(
  pairing: PairingOffer,
  clientCapabilities: readonly RuntimeCapability[],
  callbacks: RemoteRuntimePassthroughCallbacks,
  options: RemoteRuntimeSocketLivenessOptions & { timeoutMs: number }
): Promise<RemoteRuntimePassthroughSocket> {
  return new Promise((resolve, reject) => {
    const keyPair = generateKeyPair()
    const sharedKey = deriveSharedKey(keyPair.secretKey, publicKeyFromBase64(pairing.publicKeyB64))
    let state: 'awaiting_ready' | 'awaiting_authenticated' | 'ready' | 'ended' = 'awaiting_ready'
    let ws: WebSocket
    const outbound = new RemoteRuntimeSubscriptionOutbound({ fail: (error) => end(error) })
    const handle: RemoteRuntimePassthroughSocket = {
      send: (plaintext) =>
        state === 'ready' && ws.readyState === WebSocket.OPEN
          ? outbound.enqueueRequest(ws, encrypt(plaintext, sharedKey))
          : false,
      close: () => end(null)
    }
    const timeout = setTimeout(
      () =>
        end(
          new RemoteRuntimeClientError(
            'runtime_timeout',
            'Timed out connecting to the remote Orca runtime.'
          )
        ),
      options.timeoutMs
    )
    const liveness = startRemoteRuntimeSocketLiveness({
      ping: () => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping()
        }
      },
      onDead: () =>
        end(
          new RemoteRuntimeClientError(
            'remote_runtime_unavailable',
            'Remote Orca runtime stopped responding; the connection was reset.'
          )
        ),
      options
    })

    function end(error: RemoteRuntimeClientError | null): void {
      if (state === 'ended') {
        return
      }
      const wasReady = state === 'ready'
      state = 'ended'
      clearTimeout(timeout)
      liveness.stop()
      outbound.releaseQueues()
      outbound.retainSocketMemoryUntilClose(ws)
      ws.off('message', onMessage)
      closeRemoteRuntimeSocket(ws)
      if (!wasReady) {
        reject(
          error ??
            new RemoteRuntimeClientError('remote_runtime_unavailable', 'Remote runtime closed.')
        )
      } else if (error) {
        callbacks.onClose(error)
      }
    }

    function protocolError(message: string): RemoteRuntimeClientError {
      return new RemoteRuntimeClientError('invalid_runtime_response', message)
    }

    function onMessage(data: WebSocket.RawData, isBinary: boolean): void {
      liveness.noteActivity()
      if (isBinary) {
        // Why Buffer only: a socket left at the default binaryType delivers nothing else.
        const bytes =
          state === 'ready' && Buffer.isBuffer(data)
            ? decryptBytes(new Uint8Array(data), sharedKey)
            : null
        if (!bytes) {
          end(protocolError('Remote Orca runtime returned an unreadable binary frame.'))
          return
        }
        callbacks.onBinary(bytes)
        return
      }
      const frame = data.toString()
      if (state === 'awaiting_ready') {
        if (classifyRemoteRuntimeReadyFrame(frame) !== 'ready') {
          end(protocolError('Remote Orca runtime returned an invalid E2EE handshake frame.'))
          return
        }
        state = 'awaiting_authenticated'
        ws.send(
          encrypt(
            serializeRemoteRuntimePayload({
              type: 'e2ee_auth',
              deviceToken: pairing.deviceToken,
              clientCapabilities
            }),
            sharedKey
          )
        )
        return
      }
      const plaintext = decrypt(frame, sharedKey)
      if (plaintext === null) {
        end(protocolError('Remote Orca runtime returned an undecryptable frame.'))
        return
      }
      if (state === 'ready') {
        callbacks.onText(plaintext)
        return
      }
      const authenticated = parseRemoteRuntimeAuthenticatedFrame(plaintext)
      if (authenticated.kind !== 'authenticated') {
        end(
          authenticated.kind === 'rejected' && authenticated.unauthorized
            ? new RemoteRuntimeClientError(
                'unauthorized',
                'Remote Orca runtime rejected the pairing token.'
              )
            : protocolError('Remote Orca runtime returned an invalid E2EE auth frame.')
        )
        return
      }
      state = 'ready'
      clearTimeout(timeout)
      resolve(handle)
    }

    try {
      ws = new WebSocket(
        pairing.endpoint,
        remoteRuntimeConnectOptions({ maxPayload: REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES })
      )
    } catch (error) {
      clearTimeout(timeout)
      liveness.stop()
      reject(
        new RemoteRuntimeClientError(
          'invalid_argument',
          `Invalid remote endpoint: ${String(error)}`
        )
      )
      return
    }
    ws.once('open', () =>
      ws.send(
        JSON.stringify({ type: 'e2ee_hello', publicKeyB64: publicKeyToBase64(keyPair.publicKey) })
      )
    )
    ws.on('error', (error) =>
      end(
        new RemoteRuntimeClientError(
          'remote_runtime_unavailable',
          remoteRuntimeConnectFailureMessage(error, pairing.endpoint)
        )
      )
    )
    ws.on('close', (code, reason) =>
      end(
        new RemoteRuntimeClientError(
          'remote_runtime_unavailable',
          formatRemoteRuntimeCloseMessage(code, reason)
        )
      )
    )
    ws.on('message', onMessage)
    ws.on('pong', () => liveness.noteActivity())
    ws.on('ping', () => liveness.noteActivity())
  })
}
