/**
 * What a method lets its caller do to this Orca, declared on every method definition.
 *
 * The dispatcher grants each caller kind a set of these (rpc-caller-scope.ts), so a new method
 * cannot ship without someone deciding which callers may reach it.
 */
export type RpcMethodPermission =
  /** Projects, worktrees, terminals, files, git, browser, orchestration and integrations. */
  | 'workspace'
  /** Drives this machine's own desktop: clicks, keys and app state outside Orca. */
  | 'desktop-control'
  /** Adds, removes or switches agent and integration accounts and their credentials. */
  | 'accounts-admin'
  /** Changes Orca settings. */
  | 'settings-write'
  /** Installs, publishes or removes agent skills. */
  | 'skills-admin'
  /** Pairing offers, relay credentials and push registration for paired devices. */
  | 'pairing-admin'
  /** Updates, managed servers, SSH connections, plugins and network tunnels on this host. */
  | 'host-admin'

export const RPC_METHOD_PERMISSIONS: readonly RpcMethodPermission[] = [
  'workspace',
  'desktop-control',
  'accounts-admin',
  'settings-write',
  'skills-admin',
  'pairing-admin',
  'host-admin'
]
