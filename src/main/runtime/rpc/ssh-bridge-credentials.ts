/**
 * Short-lived credentials for the `orca` CLI an SSH host runs through this host's bridge.
 *
 * One credential per invocation, bound to the SSH target and connection incarnation that relayed it,
 * revoked when the invocation settles. The runtime socket maps it to that target's bridge scope, so
 * the child CLI never holds the owner token.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import type { RpcCallerScope } from './rpc-caller-scope'

export type SshBridgeCallerScope = Extract<RpcCallerScope, { kind: 'ssh-bridge' }>

export type SshBridgeCredentialBinding = {
  scope: SshBridgeCallerScope
  connectionIncarnation: string
  invocationId: string
}

export type SshBridgeCredential = {
  token: string
  binding: SshBridgeCredentialBinding
  revoke: () => void
}

export class SshBridgeCredentialRegistry {
  private readonly bindings = new Map<string, SshBridgeCredentialBinding>()

  mint(scope: SshBridgeCallerScope, connectionIncarnation: string): SshBridgeCredential {
    const token = `sshb_${randomBytes(24).toString('hex')}`
    const binding: SshBridgeCredentialBinding = {
      scope: { ...scope },
      connectionIncarnation,
      invocationId: randomUUID()
    }
    this.bindings.set(token, binding)
    return { token, binding, revoke: () => this.bindings.delete(token) }
  }

  resolve(token: string): SshBridgeCredentialBinding | null {
    return this.bindings.get(token) ?? null
  }
}

export const sshBridgeCredentials = new SshBridgeCredentialRegistry()
