import type { ExecutionHostId } from '../../../src/shared/execution-host'
import { z } from 'zod'
import {
  MOBILE_DESKTOP_OWNED_TABS_RUNTIME_CAPABILITY,
  MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY
} from '../../../src/shared/mobile-desktop-relay-contract'
import { composeDesktopOwnedSessionTabs } from './desktop-owned-session-tabs'
import type { RpcClient, SendRequestOptions } from './rpc-client'
import { isSnapshotResult } from './rpc-subscription-result-shapes'

const scopedViews = new WeakMap<RpcClient, Map<string, RpcClient>>()

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

/**
 * The `executionHost` a route into a workspace carries: none for the desktop's own (local, SSH),
 * the server for a reachable one, and null for one this phone cannot reach, which must not open.
 */
export function workspaceRouteExecutionHost(
  client: RpcClient | null,
  hostCapabilities: readonly string[],
  executionHost: ExecutionHostId | undefined
): ExecutionHostId | undefined | null {
  if (!executionHost?.startsWith('runtime:')) {
    return undefined
  }
  return client && relaysToServers(client, hostCapabilities) ? executionHost : null
}

/**
 * The paired desktop's client with every call run on `executionHost`, mirroring the desktop's
 * `callRuntimeRpc(target, …)`. One view per (client, host), so screens comparing client identity
 * keep working; the view owns no connection, so `close` leaves the shared client open.
 *
 * With `composesDesktopTabs`, the session strip also carries the desktop's own editor tabs, and a
 * call naming one of them runs on the desktop, which holds it (composeDesktopOwnedSessionTabs).
 */
export function scopeRpcClientToExecutionHost(
  client: RpcClient,
  executionHost: ExecutionHostId,
  composesDesktopTabs = false
): RpcClient {
  let views = scopedViews.get(client)
  if (!views) {
    views = new Map()
    scopedViews.set(client, views)
  }
  const viewKey = `${executionHost}${composesDesktopTabs ? '+desktop-tabs' : ''}`
  const existing = views.get(viewKey)
  if (existing) {
    return existing
  }
  const desktopTabIdsByWorktree = new Map<string, ReadonlySet<string>>()
  const owner = (params: unknown): ExecutionHostId | undefined => {
    const tabId = TabCallParamsSchema.safeParse(params).data?.tabId
    const ownedByDesktop =
      composesDesktopTabs &&
      tabId !== undefined &&
      [...desktopTabIdsByWorktree.values()].some((ids) => ids.has(tabId))
    return ownedByDesktop ? undefined : executionHost
  }
  const compose = (params: unknown, server: unknown, desktop: unknown): unknown => {
    const composed = composeDesktopOwnedSessionTabs(server, desktop)
    const worktree = TabCallParamsSchema.safeParse(params).data?.worktree
    if (worktree !== undefined) {
      desktopTabIdsByWorktree.set(worktree, composed.desktopTabIds)
    }
    return composed.result
  }
  const send = (
    method: string,
    params: unknown,
    options: SendRequestOptions | undefined,
    host: ExecutionHostId | undefined
  ) => client.sendRequest(method, params, host ? { ...options, executionHost: host } : options)
  const listen = (
    method: string,
    params: unknown,
    listener: (frame: unknown) => void,
    options: Parameters<RpcClient['subscribe']>[3],
    host: ExecutionHostId | undefined
  ) =>
    client.subscribe(method, params, listener, host ? { ...options, executionHost: host } : options)
  const view: RpcClient = {
    sendRequest: async (method, params, options) => {
      if (!composesDesktopTabs || method !== 'session.tabs.list') {
        return send(method, params, options, owner(params))
      }
      const [server, desktop] = await Promise.all([
        send(method, params, options, executionHost),
        send(method, params, options, undefined).catch(() => null)
      ])
      return server.ok && desktop?.ok
        ? { ...server, result: compose(params, server.result, desktop.result) }
        : server
    },
    subscribe: (method, params, onData, options) =>
      composesDesktopTabs && method === 'session.tabs.subscribe'
        ? subscribeComposedSessionTabs(
            (host, listener) => listen(method, params, listener, options, host),
            executionHost,
            (server, desktop) => compose(params, server, desktop),
            onData
          )
        : listen(method, params, onData, options, owner(params)),
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
  views.set(viewKey, view)
  return view
}

const TabCallParamsSchema = z.looseObject({
  tabId: z.string().optional(),
  worktree: z.string().optional()
})

/**
 * One session-tabs stream from the server and one from the desktop, as a single stream. Only the
 * server's frames start or end it; a desktop change re-sends the last server frame as an update.
 */
function subscribeComposedSessionTabs(
  open: (host: ExecutionHostId | undefined, listener: (frame: unknown) => void) => () => void,
  executionHost: ExecutionHostId,
  compose: (server: unknown, desktop: unknown) => unknown,
  onData: (frame: unknown) => void
): () => void {
  let server: unknown = null
  let desktop: unknown = null
  const stopServer = open(executionHost, (frame) => {
    const isTabs = isSnapshotResult(frame) || isUpdatedResult(frame)
    server = isTabs ? frame : server
    onData(isTabs ? compose(frame, desktop) : frame)
  })
  const stopDesktop = open(undefined, (frame) => {
    if (!isSnapshotResult(frame) && !isUpdatedResult(frame)) {
      return
    }
    desktop = frame
    if (server !== null) {
      onData({ ...asRecord(compose(server, desktop)), type: 'updated' })
    }
  })
  return () => {
    stopServer()
    stopDesktop()
  }
}

function isUpdatedResult(value: unknown): boolean {
  return UpdatedFrameSchema.safeParse(value).success
}

const UpdatedFrameSchema = z.looseObject({ type: z.literal('updated') })

function asRecord(value: unknown): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).safeParse(value).data ?? {}
}

/**
 * The client for calls about a workspace on `executionHost`: the desktop's own for its workspaces,
 * a scoped view for a reachable server, and null for a server not reachable yet — never the
 * desktop client for a server's workspace, which would run the call on the wrong computer.
 */
export function rpcClientForExecutionHost(
  client: RpcClient,
  hostCapabilities: readonly string[],
  executionHost: ExecutionHostId | undefined
): RpcClient | null {
  const routeHost = workspaceRouteExecutionHost(client, hostCapabilities, executionHost)
  if (routeHost === undefined) {
    return client
  }
  return (
    routeHost &&
    scopeRpcClientToExecutionHost(client, routeHost, composesDesktopTabs(hostCapabilities))
  )
}

/** Whether the desktop publishes its own tabs of a server workspace in the strip's order. */
export function composesDesktopTabs(hostCapabilities: readonly string[]): boolean {
  return hostCapabilities.includes(MOBILE_DESKTOP_OWNED_TABS_RUNTIME_CAPABILITY)
}
