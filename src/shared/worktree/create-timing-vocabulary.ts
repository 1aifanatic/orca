/** Every phase a worktree create times. Closed so phase names can become span attributes and
 *  event fields without ever carrying a branch name, a ref, or a path. */
export const WORKTREE_CREATE_PHASES = [
  'resolve_name',
  'refresh_base_ref',
  'git_worktree_add',
  'prepared_checkout_wait',
  'prepared_checkout_finalize',
  'list_created_worktree',
  'persist_metadata',
  'create_symlinks',
  'resolve_shared_directories',
  'resolve_worktreeinclude',
  'create_shared_directories',
  'copy_worktreeinclude',
  'prepare_setup',
  'spawn_startup_terminal'
] as const

export type WorktreeCreatePhase = (typeof WORKTREE_CREATE_PHASES)[number]

/** Closed vocabulary: these values reach span attributes, so none of them may ever
 *  be derived from a branch name, a ref, or a path. */
export const PREPARED_CHECKOUT_MISS_REASONS = [
  'none_armed',
  /** Preparations exist, but none for this repo — it was never warmed, or the pool's size cap
   *  evicted it for another repo. Distinguished from `none_armed` because it is the signal that
   *  the cap is thrashing for a multi-project user. */
  'repo_mismatch',
  'base_mismatch',
  'retarget_too_divergent',
  /** The drift check returned no answer. Distinct from `retarget_too_divergent` because that one
   *  is the bound working as intended, while this one means a possibly cheap retarget was skipped
   *  anyway. Deliberately a mixed bucket — a blown deadline, a cancelled create, and an ordinary
   *  Git failure such as a missing ref all land here — so treat a rise as "look at why", not as a
   *  direct readout of the budget being too small. */
  'retarget_unverifiable',
  'workspace_root_mismatch',
  'wsl_distro_mismatch',
  'prepare_failed',
  'finalize_failed',
  'checkout_existing_branch',
  'sparse_checkout'
] as const

export type PreparedCheckoutMissReason = (typeof PREPARED_CHECKOUT_MISS_REASONS)[number]

/** Where the create's Git ran: the host itself, a WSL distro on it, or an SSH remote. */
export const WORKTREE_CREATE_EXECUTION_HOSTS = ['local', 'wsl', 'ssh'] as const

export type WorktreeCreateExecutionHost = (typeof WORKTREE_CREATE_EXECUTION_HOSTS)[number]
