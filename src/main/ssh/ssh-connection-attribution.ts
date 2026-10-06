/**
 * Which connect attempt opened a pooled SSH transport, and who has since taken it over. A
 * cancelled attempt may close only a transport it opened itself and no newer owner adopted: a
 * replacement connect or a managed tunnel can reuse the same pooled connection.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { SshConnection } from './ssh-connection'

const scope = new AsyncLocalStorage<symbol>()
const openers = new WeakMap<SshConnection, symbol>()
const adopters = new WeakMap<SshConnection, symbol>()
// A tunnel built outside any connect attempt (a restore, a lifecycle action) owns its transport.
const BACKGROUND_OWNER = Symbol('ssh-connection-background-owner')

/** Runs `work` so any transport the pool opens inside it is attributed to `owner`. */
export function runAttributedToSshOwner<T>(owner: symbol, work: () => Promise<T>): Promise<T> {
  return scope.run(owner, work)
}

export function recordSshConnectionOpened(connection: SshConnection): void {
  const owner = scope.getStore()
  if (owner) {
    openers.set(connection, owner)
  }
}

/** The latest user of a pooled transport; a tunnel outside any attempt counts as its own owner. */
export function adoptSshConnection(connection: SshConnection, owner?: symbol): void {
  adopters.set(connection, owner ?? scope.getStore() ?? BACKGROUND_OWNER)
}

/** True only for a transport `owner` opened and nothing newer took over. */
export function isSshConnectionSolelyOwnedBy(connection: SshConnection, owner: symbol): boolean {
  return openers.get(connection) === owner && (adopters.get(connection) ?? owner) === owner
}
