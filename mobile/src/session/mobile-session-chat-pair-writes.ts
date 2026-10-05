import {
  createChatPairPendingWrites,
  type ChatPairPendingWrites,
  type ChatPairWriteReply,
  type ChatPairWriteRequest
} from '../../../src/shared/chat-pair-pending'
import type { RuntimeSessionTabChatViewWrite } from '../../../src/shared/runtime-session-contracts'
import type { TerminalChatPair } from '../../../src/shared/terminal-tab-view-mode'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import { structuredSessionRandomUuid } from './structured-session-operation-id'

export type MobileChatPairKey = { hostId: string; worktreeId: string; parentTabId: string }

/** What one mounted session route lends the process-wide writer for its host and worktree. */
export type MobileChatPairRouteBinding = {
  readHostPair: (parentTabId: string) => TerminalChatPair | null
  send: (
    parentTabId: string,
    request: ChatPairWriteRequest,
    write: RuntimeSessionTabChatViewWrite
  ) => Promise<ChatPairWriteReply>
  showPending: (parentTabId: string, pair: TerminalChatPair | null) => void
  reportFailure: (parentTabId: string, error: unknown) => void
}

export class MobileChatPairRouteGoneError extends Error {
  constructor() {
    super('The session screen for this workspace is closed.')
    this.name = 'MobileChatPairRouteGoneError'
  }
}

const bindings = new Map<string, MobileChatPairRouteBinding>()
let writes: ChatPairPendingWrites<MobileChatPairKey> | null = null

function scopeId(hostId: string, worktreeId: string): string {
  return `${hostId}\0${worktreeId}`
}

function bindingFor(key: MobileChatPairKey): MobileChatPairRouteBinding | undefined {
  return bindings.get(scopeId(key.hostId, key.worktreeId))
}

/** The write may have reached the host, so the same sequence number is resent once. */
export function isMobileChatPairDeliveryUnknown(error: unknown): boolean {
  return isRpcDeliveryUnknown(error) || isLogicalClientCutoverError(error)
}

/** One writer per JS context: the host fences by writer id, and the sequence never resets. */
export function getMobileChatPairWrites(): ChatPairPendingWrites<MobileChatPairKey> {
  writes ??= createChatPairPendingWrites<MobileChatPairKey>({
    writerId: structuredSessionRandomUuid(),
    keyId: (key) => `${scopeId(key.hostId, key.worktreeId)}\0${key.parentTabId}`,
    readHostPair: (key) => bindingFor(key)?.readHostPair(key.parentTabId) ?? null,
    send: (key, request, write) => {
      const binding = bindingFor(key)
      return binding
        ? binding.send(key.parentTabId, request, write)
        : Promise.reject(new MobileChatPairRouteGoneError())
    },
    isDeliveryUnknown: isMobileChatPairDeliveryUnknown,
    showPending: (key, pair) => bindingFor(key)?.showPending(key.parentTabId, pair),
    reportFailure: (key, error) => bindingFor(key)?.reportFailure(key.parentTabId, error),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the only handles passed back are the ones setTimer returned.
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
  })
  return writes
}

export function mobileChatPairKeysInScope(hostId: string, worktreeId: string): MobileChatPairKey[] {
  return getMobileChatPairWrites()
    .pendingKeys()
    .filter((key) => key.hostId === hostId && key.worktreeId === worktreeId)
}

/** Lends a route's reads and sends to the writer; returns the unbind for its cleanup. */
export function bindMobileChatPairRoute(
  hostId: string,
  worktreeId: string,
  binding: MobileChatPairRouteBinding
): () => void {
  const id = scopeId(hostId, worktreeId)
  bindings.set(id, binding)
  return () => {
    if (bindings.get(id) === binding) {
      bindings.delete(id)
    }
  }
}
