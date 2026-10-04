/** Outcome of moving an SSH host to its managed Orca server when the user asks to. */
export type SshManagedServerMoveResult =
  | { outcome: 'moved'; environmentId: string }
  /** Its relay terminals weren't proven exited after the stop, so nothing converted. */
  | { outcome: 'refused'; verdict: 'live' | 'unverifiable'; terminals: number }
  /** The terminals stopped but the connect kept the relay; the host's status line says why. */
  | { outcome: 'stayed' }
