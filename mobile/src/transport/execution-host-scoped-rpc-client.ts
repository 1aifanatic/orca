import type { ExecutionHostId } from '../../../src/shared/execution-host'
import { MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY } from '../../../src/shared/mobile-desktop-relay-contract'
import type { RpcClient } from './rpc-client'

const scopedViews = new WeakMap<RpcClient, Map<ExecutionHostId, RpcClient>>()

/**
 * Whether this phone can reach the desktop's servers: the desktop relays, over a transport that
 * keeps `executionHost` (a shell older than it would strip it and run the call on the desktop).
 */
export function relaysToServers(client: RpcClient, hostCapabilities: readonly string[]): boolean {
  return (
    hostCapabilities.includes(MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY) &&
    (client.carriesExecutionHost?.() ?? true)
  )
}

/** Local and SSH workspaces are the desktop's own; only a server's are named, and only if reachable. */
export function canTargetExecutionHost(
  client: RpcClient,
  hostCapabilities: readonly string[],
  executionHost: ExecutionHostId | undefined
): executionHost is `runtime:${string}` {
  return executionHost?.startsWith('runtime:') === true && relaysToServers(client, hostCapabilities)
}

/**
 * The paired desktop's client with every call run on `executionHost`, mirroring the desktop's
 * `callRuntimeRpc(target, …)`. One view per (client, host), so screens comparing client identity
 * keep working; the view owns no connection, so `close` leaves the shared client open.
 */
export function scopeRpcClientToExecutionHost(
  client: RpcClient,
  executionHost: ExecutionHostId
): RpcClient {
  let views = scopedViews.get(client)
  if (!views) {
    views = new Map()
    scopedViews.set(client, views)
  }
  const existing = views.get(executionHost)
  if (existing) {
    return existing
  }
  const view: RpcClient = {
    sendRequest: (method, params, options) =>
      client.sendRequest(method, params, { ...options, executionHost }),
    subscribe: (method, params, onData, options) =>
      client.subscribe(method, params, onData, { ...options, executionHost }),
    updateTerminalSubscriptionViewport: (terminal, viewport) =>
      client.updateTerminalSubscriptionViewport(terminal, viewport),
    getState: () => client.getState(),
    getReconnectAttempt: () => client.getReconnectAttempt(),
    getLastConnectedAt: () => client.getLastConnectedAt(),
    getLastInboundAt: client.getLastInboundAt && (() => client.getLastInboundAt?.() ?? null),
    getGeneration: client.getGeneration && (() => client.getGeneration?.() ?? 0),
    carriesExecutionHost: () => client.carriesExecutionHost?.() ?? true,
    onStateChange: (listener) => client.onStateChange(listener),
    notifyForeground: (reason) => client.notifyForeground(reason),
    close: () => {}
  }
  views.set(executionHost, view)
  return view
}

/** The client for calls about a workspace on `executionHost`: scoped when it may be named. */
export function rpcClientForExecutionHost(
  client: RpcClient,
  hostCapabilities: readonly string[],
  executionHost: ExecutionHostId | undefined
): RpcClient {
  return canTargetExecutionHost(client, hostCapabilities, executionHost)
    ? scopeRpcClientToExecutionHost(client, executionHost)
    : client
}
