import { DESKTOP_RPC_CALLER, rpcCallerOperationKey } from '../rpc-caller-identity'

/**
 * Temporary, until one rule serves every caller: the one signal for what only the desktop's own
 * launches do, because its window pasted them on main. The host-assigned caller identity, never a
 * request field: the desktop's write rule (`launchPromptGuardOnUnprovableHost`), its readiness
 * budget. The phone and the CLI keep main's.
 */
export function isDesktopLaunchCaller(callerKey: string | undefined): boolean {
  return callerKey === rpcCallerOperationKey(DESKTOP_RPC_CALLER)
}

/**
 * On a host that cannot find the agent in front (Windows), the desktop writes unless a shell is
 * proven there, as its own paste did on main; the phone and the CLI refuse, as they do on main.
 */
export function launchPromptGuardOnUnprovableHost(
  callerKey: string | undefined
): 'refuse' | 'write-unless-shell' {
  return isDesktopLaunchCaller(callerKey) ? 'write-unless-shell' : 'refuse'
}
