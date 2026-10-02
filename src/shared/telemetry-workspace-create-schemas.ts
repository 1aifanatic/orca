import { z } from 'zod'
import {
  PREPARED_CHECKOUT_MISS_REASONS,
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
  prepared_checkout_wait_ms: durationMsSchema,
  prepared_checkout_finalize_ms: durationMsSchema,
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

export const workspaceCreatedTimingProperties = {
  total_ms: durationMsSchema,
  /** Wall-clock time no timed phase covers. */
  unattributed_ms: durationMsSchema,
  ...phaseDurationProperties,
  prepared_checkout: z.enum(['hit', 'miss']).optional(),
  /** Hit only: the prepared checkout had to be reset onto a different ref first. */
  prepared_checkout_retargeted: z.boolean().optional(),
  prepared_checkout_miss_reason: z.enum(PREPARED_CHECKOUT_MISS_REASONS).optional(),
  execution_host: z.enum(WORKTREE_CREATE_EXECUTION_HOSTS).optional(),
  worktree_count_bucket: z.enum(WORKTREE_COUNT_BUCKETS).optional(),
  /** Most other worktree creates running in this app at once during this one. */
  concurrent_creates: z.number().int().nonnegative().optional(),
  post_checkout_hook: z.enum(POST_CHECKOUT_HOOK_PRESENCE_VALUES).optional()
}

/** `untimed` = the create failed outside every timed phase. */
export const WORKSPACE_CREATE_FAILED_PHASE_VALUES = [...WORKTREE_CREATE_PHASES, 'untimed'] as const

export const workspaceCreateFailedProperties = {
  failed_phase: z.enum(WORKSPACE_CREATE_FAILED_PHASE_VALUES).optional(),
  /** Elapsed time from the start of the create to the failure. */
  total_ms: durationMsSchema,
  execution_host: z.enum(WORKTREE_CREATE_EXECUTION_HOSTS).optional(),
  concurrent_creates: z.number().int().nonnegative().optional()
}
