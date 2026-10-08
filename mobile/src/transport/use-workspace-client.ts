import { useOptionalHostProtocolGates } from '../components/host-protocol-gates-context'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'
import { useForceReconnect, useHostClient } from './client-context'
import { rpcClientForExecutionHost } from './execution-host-scoped-rpc-client'

const NO_CAPABILITIES: readonly string[] = []

/** `useHostClient` for a workspace screen: its calls run where the workspace does. */
export function useWorkspaceClient(
  hostId: string | undefined
): ReturnType<typeof useHostClient> & { forceReconnect: ReturnType<typeof useForceReconnect> } {
  const host = useHostClient(hostId)
  const hostCapabilities = useOptionalHostProtocolGates()?.hostCapabilities ?? NO_CAPABILITIES
  const executionHost = useWorkspaceExecutionHost()
  const forceReconnect = useForceReconnect()
  return {
    ...host,
    forceReconnect,
    client: host.client && rpcClientForExecutionHost(host.client, hostCapabilities, executionHost)
  }
}
