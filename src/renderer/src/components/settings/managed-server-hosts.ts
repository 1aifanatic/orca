import type { SshConnectionState } from '../../../../shared/ssh-types'

/** "Move to managed server" needs a connected relay that has reported its platform (any of them). */
export function canMoveHostToManagedServer(state: SshConnectionState | undefined): boolean {
  return state?.status === 'connected' && state.remotePlatform !== undefined
}
