import type { Agent } from 'node:http'
import { getMainHttpClient, type MainHttpClient } from './http-client'
import { sessionProxyWebSocketAgent } from './session-proxy-agent'

// Off is the pre-setting path exactly: Node's global fetch and direct websockets.
let useSystemProxy = false

/** Returns whether the route changed. */
export function setRelayAndCloudUseSystemProxy(enabled: boolean): boolean {
  const changed = useSystemProxy !== enabled
  useSystemProxy = enabled
  return changed
}

/** Fetch for Orca Relay and Orca Cloud requests, honouring the "use system proxy" setting. */
export function relayAndCloudFetch(): MainHttpClient['fetch'] {
  return useSystemProxy ? getMainHttpClient().fetch : (url, init) => globalThis.fetch(url, init)
}

/** ws `agent` for relay sockets; undefined keeps the direct connection. */
export function relayWebSocketAgent(url: string): Agent | undefined {
  return useSystemProxy ? sessionProxyWebSocketAgent(url) : undefined
}
