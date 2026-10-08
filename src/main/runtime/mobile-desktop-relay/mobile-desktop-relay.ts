import { randomUUID } from 'node:crypto'
import type { MobileDesktopRelayHostState } from '../../../shared/mobile-desktop-relay-contract'
import type { DelegatedMobileDeviceSyncParams } from '../../../shared/delegated-mobile-device-contract'
import type { RuntimeCapability } from '../../../shared/protocol-version'
import { RemoteRuntimeClientError } from '../../../shared/remote-runtime-client-error'
import {
  openRemoteRuntimePassthroughSocket,
  type RemoteRuntimePassthroughSocket
} from '../../../shared/remote-runtime-passthrough-socket'
import { MOBILE_RPC_METHOD_ROUTES } from '../runtime-rpc/runtime-rpc-mobile-method-routing'
import { syncDelegatedPhoneGrants, type DelegatedPhoneGrants } from './delegated-phone-grants'
import type { MobileDesktopRelayHost, MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'
import { RELAYED_STREAM_CARRIERS } from './relayed-stream-carriers'
import { RelayedPhoneReplies, rewriteRelayedPhoneRequest } from './relayed-phone-frames'

const RELAY_CONNECT_TIMEOUT_MS = 15_000

/** The phone connection a relayed request arrived on. */
export type RelayedPhone = {
  connectionId: string
  deviceId: string
  deviceToken: string
  clientCapabilities: () => readonly RuntimeCapability[]
  reply: (frame: string) => void
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => boolean | void
}

type OpenedRelayLink = { socket: RemoteRuntimePassthroughSocket; hostToken: string }

class RelayLink {
  socket?: RemoteRuntimePassthroughSocket
  readonly replies: RelayedPhoneReplies
  readonly opened: Promise<OpenedRelayLink>

  constructor(
    readonly environmentId: string,
    readonly phone: RelayedPhone,
    allocateStreamId: () => number,
    open: (link: RelayLink) => Promise<OpenedRelayLink>
  ) {
    this.replies = new RelayedPhoneReplies(allocateStreamId)
    this.opened = open(this)
  }
}

/**
 * Relays a phone request carrying `executionHost: runtime:<env>` to that configured server, over one
 * socket per (phone connection, server) signed in as the phone's delegated device (minted by
 * `pairing.delegatedMobileDevice.sync`, tokens held in memory only). Contract:
 * - The desktop never interprets replies; it renumbers only host stream ids (RELAYED_STREAM_CARRIERS).
 * - Upstream, the phone's desktop token is swapped wherever it appears, not per field.
 * - Only `execution-host` methods relay (MOBILE_RPC_METHOD_ROUTES); both tables have census tests.
 * - A server without the delegated-devices capability is `update-needed`; nothing relays to it.
 * - Hidden until S2: MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY is not advertised yet.
 */
export class MobileDesktopRelay {
  private readonly links = new Map<string, RelayLink>()
  private readonly grants = new Map<string, Promise<DelegatedPhoneGrants>>()
  private readonly stopRetirementWatch: () => void

  constructor(
    private readonly options: {
      hosts: MobileDesktopRelayHosts
      listPhones: () => DelegatedMobileDeviceSyncParams['phones']
      allocateStreamId: () => number
    }
  ) {
    this.stopRetirementWatch = options.hosts.onEnvironmentRetired((environmentId) =>
      this.retireEnvironment(environmentId)
    )
  }

  dispose(): void {
    this.stopRetirementWatch()
    for (const link of this.links.values()) {
      this.endLink(link, unavailable('The paired desktop stopped relaying.'))
    }
    this.grants.clear()
  }

  forward(
    phone: RelayedPhone,
    environmentId: string,
    request: { id: string; method: string },
    frame: string
  ): void {
    if (
      MOBILE_RPC_METHOD_ROUTES.get(request.method) !== 'execution-host' ||
      RELAYED_STREAM_CARRIERS.get(request.method) === 'phone-binary-frames'
    ) {
      phone.reply(
        failure(request.id, 'forbidden', `Method '${request.method}' runs on the paired desktop`)
      )
      return
    }
    const link = this.linkFor(phone, environmentId)
    link.replies.noteForwarded(request.id)
    link.opened.then(
      ({ socket, hostToken }) => {
        if (!socket.send(rewriteRelayedPhoneRequest(frame, phone.deviceToken, hostToken))) {
          this.endLink(link, unavailable('The server connection could not take the request.'))
        }
      },
      () => {
        // The open failure already answered every request queued on this link.
      }
    )
  }

  /** Mirrors a phone's capability update to every server socket that phone has open. */
  forwardClientCapabilities(connectionId: string, frame: string): void {
    for (const link of this.links.values()) {
      if (link.phone.connectionId !== connectionId) {
        continue
      }
      // Why a fresh id: the phone already has the desktop's answer to its own id.
      const id = `relay-capabilities:${randomUUID()}`
      link.replies.noteForwarded(id, { swallowReplies: true })
      link.opened.then(
        ({ socket, hostToken }) =>
          socket.send(rewriteRelayedPhoneRequest(frame, link.phone.deviceToken, hostToken, id)),
        () => {}
      )
    }
  }

  closePhoneConnection(connectionId: string): void {
    for (const link of this.links.values()) {
      if (link.phone.connectionId === connectionId) {
        this.endLink(link, null)
      }
    }
  }

  /** The server was removed, re-paired or disconnected: drop its sockets and grants. */
  retireEnvironment(environmentId: string): void {
    this.grants.delete(environmentId)
    for (const link of this.links.values()) {
      if (link.environmentId === environmentId) {
        this.endLink(link, unavailable('The server connection was reset.'))
      }
    }
  }

  /** The desktop's paired phones changed: re-sync every server already holding grants. */
  phonesChanged(): void {
    for (const environmentId of this.grants.keys()) {
      this.grants.delete(environmentId)
      void this.hostState(environmentId)
    }
  }

  async hostState(environmentId: string): Promise<MobileDesktopRelayHostState> {
    try {
      const host = await this.options.hosts.resolve(environmentId)
      return host ? (await this.grantsFor(host, null)).kind : 'unavailable'
    } catch {
      return 'unavailable'
    }
  }

  private linkFor(phone: RelayedPhone, environmentId: string): RelayLink {
    const key = linkKey(phone.connectionId, environmentId)
    const existing = this.links.get(key)
    if (existing) {
      return existing
    }
    const link = new RelayLink(environmentId, phone, this.options.allocateStreamId, (opening) =>
      this.open(opening)
    )
    link.opened.catch((error: unknown) => {
      this.endLink(
        link,
        error instanceof RemoteRuntimeClientError ? error : unavailable(String(error))
      )
    })
    this.links.set(key, link)
    return link
  }

  private async open(link: RelayLink): Promise<OpenedRelayLink> {
    const { phone } = link
    const host = await this.options.hosts.resolve(link.environmentId)
    if (!host) {
      throw unavailable('The server is not configured on this computer.')
    }
    const grants = await this.grantsFor(host, phone.deviceId)
    if (grants.kind === 'update-needed') {
      throw unavailable('The server needs an Orca update to open its workspaces from a phone.')
    }
    const grant = grants.grants.get(phone.deviceId)
    if (!grant || grants.refused.has(phone.deviceId)) {
      throw unavailable('The server does not accept this phone.')
    }
    try {
      const socket = await openRemoteRuntimePassthroughSocket(
        {
          ...host.pairing,
          deviceToken: grant.token,
          pairedDeviceId: grant.deviceId,
          scope: 'mobile'
        },
        phone.clientCapabilities(),
        {
          onText: (plaintext) => {
            const frame = link.replies.text(plaintext)
            if (frame !== null) {
              phone.reply(frame)
            }
          },
          onBinary: (bytes) => {
            const frame = link.replies.binary(bytes)
            if (frame) {
              phone.sendBinary(frame)
            }
          },
          onClose: (error) => this.endLink(link, error)
        },
        { timeoutMs: RELAY_CONNECT_TIMEOUT_MS }
      )
      if (this.links.get(linkKey(phone.connectionId, link.environmentId)) !== link) {
        socket.close()
        throw unavailable('The relayed request was cancelled.')
      }
      link.socket = socket
      return { socket, hostToken: grant.token }
    } catch (error) {
      if (error instanceof RemoteRuntimeClientError && error.code === 'unauthorized') {
        // Why: retrying a revoked token would only raise the host's "unpaired device" prompt.
        grants.refused.add(phone.deviceId)
        throw unavailable('The server revoked this phone.')
      }
      throw error
    }
  }

  private grantsFor(
    host: MobileDesktopRelayHost,
    phoneKey: string | null
  ): Promise<DelegatedPhoneGrants> {
    const cached = this.grants.get(host.environmentId)
    const sync = (): Promise<DelegatedPhoneGrants> => {
      const pending = syncDelegatedPhoneGrants(this.options.hosts, host, this.options.listPhones())
      this.grants.set(host.environmentId, pending)
      pending.catch(() => {
        // Why: an unreachable server is not an answer; the next request syncs again.
        if (this.grants.get(host.environmentId) === pending) {
          this.grants.delete(host.environmentId)
        }
      })
      return pending
    }
    if (!cached) {
      return sync()
    }
    return cached.then((grants) =>
      grants.fence !== host.fence ||
      (phoneKey !== null && grants.kind === 'ready' && !grants.grants.has(phoneKey))
        ? this.grants.get(host.environmentId) === cached
          ? sync()
          : this.grantsFor(host, phoneKey)
        : grants
    )
  }

  private endLink(link: RelayLink, error: RemoteRuntimeClientError | null): void {
    const key = linkKey(link.phone.connectionId, link.environmentId)
    if (this.links.get(key) !== link) {
      return
    }
    this.links.delete(key)
    link.socket?.close()
    const openRequestIds = link.replies.takeOpenRequestIds()
    if (error) {
      for (const id of openRequestIds) {
        link.phone.reply(failure(id, 'remote_runtime_unavailable', error.message))
      }
    }
  }
}

function linkKey(connectionId: string, environmentId: string): string {
  return `${connectionId}\0${environmentId}`
}

function unavailable(message: string): RemoteRuntimeClientError {
  return new RemoteRuntimeClientError('remote_runtime_unavailable', message)
}

function failure(id: string, code: string, message: string): string {
  return JSON.stringify({ id, ok: false, error: { code, message }, _meta: { runtimeId: null } })
}
