import { z } from 'zod'
import {
  PREPARED_CHECKOUT_MISS_REASONS,
  PREPARED_CHECKOUT_ORIGINS,
  PREPARED_CHECKOUT_RESETS,
  WORKSPACE_CREATE_ENTRY_POINTS,
  WORKTREE_CREATE_EXECUTION_HOSTS,
  WORKTREE_CREATE_PHASES,
  type WorktreeCreatePhase
} from './worktree/create-timing-vocabulary'

// Why numbers and closed enums only: these fields explain where create time went on real
// machines; a path, branch, ref or error string would identify the repo, so none may appear.
// Every field is optional: folder workspaces and creates outside the timed paths omit them.

const durationMsSchema = z.number().int().nonnegative().optional()

export const WORKTREE_COUNT_BUCKETS = [
  '1',
  '2-5',
  '6-20',
  '21-100',
  '101-300',
  '301-1000',
  '1001+'
] as const

/** Byte size of the main repo's `.git/index`, a proxy for tracked-file count (~100 bytes per file):
 *  roughly under 1k, 10k, 100k and 500k files, then monorepos. */
export const REPO_INDEX_SIZE_BUCKETS = [
  '<100KB',
  '100KB-1MB',
  '1-10MB',
  '10-50MB',
  '50MB+'
] as const

export const POST_CHECKOUT_HOOK_PRESENCE_VALUES = [
  'present',
  'absent',
  'custom_hooks_path',
  'unknown'
] as const

const phaseDurationProperties = {
  resolve_name_ms: durationMsSchema,
  refresh_base_ref_ms: durationMsSchema,
  git_worktree_add_ms: durationMsSchema,
  prepared_checkout_claim_ms: durationMsSchema,
  prepared_checkout_wait_ms: durationMsSchema,
  prepared_checkout_finalize_ms: durationMsSchema,
  prepared_checkout_discard_ms: durationMsSchema,
  list_created_worktree_ms: durationMsSchema,
  persist_metadata_ms: durationMsSchema,
  create_symlinks_ms: durationMsSchema,
  resolve_shared_directories_ms: durationMsSchema,
  resolve_worktreeinclude_ms: durationMsSchema,
  create_shared_directories_ms: durationMsSchema,
  copy_worktreeinclude_ms: durationMsSchema,
  prepare_setup_ms: durationMsSchema,
  spawn_startup_terminal_ms: durationMsSchema
}

// Compile-time: one duration key per timed phase, no more and no fewer.
type _PhaseKeys = `${WorktreeCreatePhase}_ms`
type _PhaseDurationKeys = keyof typeof phaseDurationProperties
type _PhaseDurationSync = [_PhaseKeys] extends [_PhaseDurationKeys]
  ? [_PhaseDurationKeys] extends [_PhaseKeys]
    ? true
    : never
  : never
const _phaseDurationSyncCheck: _PhaseDurationSync = true
void _phaseDurationSyncCheck

const countSchema = z.number().int().nonnegative().optional()

/** Fields both events carry: which entry point ran, where Git ran, and what competed for the disk. */
const workspaceCreateContextProperties = {
  create_entry_point: z.enum(WORKSPACE_CREATE_ENTRY_POINTS).optional(),
  execution_host: z.enum(WORKTREE_CREATE_EXECUTION_HOSTS).optional(),
  /** Most other worktree creates running in this app at once during this one. */
  concurrent_creates: countSchema,
  /** Most prepared-checkout builds and discards running at once during this create, not counting
   *  the prepared checkout this create used. */
  concurrent_preparations: countSchema
}

/** The prepared-checkout outcome, sent on success and failure alike. */
const preparedCheckoutProperties = {
  prepared_checkout: z.enum(['hit', 'miss']).optional(),
  /** Hit only: the reset the prepared checkout needed before it was handed over. */
  prepared_checkout_reset: z.enum(PREPARED_CHECKOUT_RESETS).optional(),
  /** Hit only: whether the new-worktree UI or the automatic burst replacement armed it. */
  prepared_checkout_origin: z.enum(PREPARED_CHECKOUT_ORIGINS).optional(),
  prepared_checkout_miss_reason: z.enum(PREPARED_CHECKOUT_MISS_REASONS).optional()
}

export const workspaceCreatedTimingProperties = {
  total_ms: durationMsSchema,
  /** Wall-clock time no timed phase covers. */
  unattributed_ms: durationMsSchema,
  // The prepared_checkout_* phases run inside git_worktree_add, so the plain checkout is the
  // add minus them.
  ...phaseDurationProperties,
  ...preparedCheckoutProperties,
  ...workspaceCreateContextProperties,
  worktree_count_bucket: z.enum(WORKTREE_COUNT_BUCKETS).optional(),
  repo_index_size_bucket: z.enum(REPO_INDEX_SIZE_BUCKETS).optional(),
  post_checkout_hook: z.enum(POST_CHECKOUT_HOOK_PRESENCE_VALUES).optional()
}

/** `untimed` = the create failed outside every timed phase. */
export const WORKSPACE_CREATE_FAILED_PHASE_VALUES = [...WORKTREE_CREATE_PHASES, 'untimed'] as const

export const workspaceCreateFailedProperties = {
  failed_phase: z.enum(WORKSPACE_CREATE_FAILED_PHASE_VALUES).optional(),
  /** Elapsed time from the start of the create to the failure. */
  total_ms: durationMsSchema,
  ...preparedCheckoutProperties,
  prepared_checkout_wait_ms: durationMsSchema,
  ...workspaceCreateContextProperties
}
