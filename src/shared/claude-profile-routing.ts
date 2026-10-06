/** Account homes are now the sole managed Claude credential owner. */
export function claudeProfileRoutingEnabled(): boolean {
  return true
}

/** The pane's path to the which-account file the `claude` shell function re-reads on every launch. */
export const CLAUDE_PROFILE_POINTER_ENV = 'ORCA_CLAUDE_PROFILE_POINTER'
