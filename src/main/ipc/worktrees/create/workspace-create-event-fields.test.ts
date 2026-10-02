import { describe, expect, it } from 'vitest'
import { eventSchemas } from '../../../../shared/telemetry-event-registry'
import { createWorktreeCreateTimingRecorder } from '../../../worktree-create-timing'
import {
  bucketWorktreeCount,
  workspaceCreateFailureFields,
  workspaceCreateTimingFields
} from './workspace-create-event-fields'

describe('workspaceCreateTimingFields', () => {
  it('maps a local create with a prepared-checkout hit', () => {
    const fields = workspaceCreateTimingFields(
      {
        totalDurationMs: 1_000.4,
        phases: [
          { phase: 'refresh_base_ref', startedAtMs: 0, durationMs: 200.6 },
          { phase: 'git_worktree_add', startedAtMs: 200, durationMs: 500 },
          { phase: 'prepared_checkout_wait', startedAtMs: 200, durationMs: 300 },
          { phase: 'list_created_worktree', startedAtMs: 700, durationMs: 100 }
        ],
        preparedCheckout: { status: 'hit', retargeted: false },
        executionHost: 'local',
        worktreeCount: 812
      },
      { concurrentCreates: 1, postCheckoutHook: 'absent' }
    )

    expect(fields).toEqual({
      total_ms: 1_000,
      unattributed_ms: 200,
      refresh_base_ref_ms: 201,
      git_worktree_add_ms: 500,
      prepared_checkout_wait_ms: 300,
      list_created_worktree_ms: 100,
      prepared_checkout: 'hit',
      prepared_checkout_retargeted: false,
      execution_host: 'local',
      worktree_count_bucket: '301-1000',
      concurrent_creates: 1,
      post_checkout_hook: 'absent'
    })
    expect(
      eventSchemas.workspace_created.safeParse({
        source: 'sidebar',
        from_existing_branch: false,
        ...fields
      }).success
    ).toBe(true)
  })

  it('maps a miss with its reason and omits what the create did not learn', () => {
    const fields = workspaceCreateTimingFields(
      {
        totalDurationMs: 50,
        phases: [],
        preparedCheckout: { status: 'miss', reason: 'none_armed' }
      },
      { concurrentCreates: 0 }
    )

    expect(fields).toEqual({
      total_ms: 50,
      unattributed_ms: 50,
      prepared_checkout: 'miss',
      prepared_checkout_miss_reason: 'none_armed',
      concurrent_creates: 0
    })
  })

  it('sums a repeated phase and drops names outside the closed vocabulary', () => {
    const fields = workspaceCreateTimingFields(
      {
        totalDurationMs: 100,
        phases: [
          { phase: 'refresh_base_ref', startedAtMs: 0, durationMs: 10 },
          { phase: 'refresh_base_ref', startedAtMs: 10, durationMs: 15 },
          { phase: '/Users/alice/repo', startedAtMs: 25, durationMs: 5 }
        ]
      },
      { concurrentCreates: 0 }
    )

    expect(fields.refresh_base_ref_ms).toBe(25)
    expect(Object.keys(fields).some((key) => key.includes('alice'))).toBe(false)
  })
})

describe('workspaceCreateFailureFields', () => {
  it('names the failing phase and the elapsed time', async () => {
    let now = 0
    const recorder = createWorktreeCreateTimingRecorder(() => now)
    recorder.recordExecutionHost('ssh')
    await recorder
      .time('git_worktree_add', async () => {
        now = 4_200
        throw new Error('fatal: could not create work tree dir /Users/alice/x')
      })
      .catch(() => undefined)

    const fields = workspaceCreateFailureFields(recorder, { concurrentCreates: 3 })

    expect(fields).toEqual({
      failed_phase: 'git_worktree_add',
      total_ms: 4_200,
      execution_host: 'ssh',
      concurrent_creates: 3
    })
    expect(
      eventSchemas.workspace_create_failed.safeParse({
        source: 'sidebar',
        error_class: 'git_failed',
        ...fields
      }).success
    ).toBe(true)
  })

  it('reports untimed when the create failed outside every phase', () => {
    const recorder = createWorktreeCreateTimingRecorder(() => 0)
    expect(workspaceCreateFailureFields(recorder, { concurrentCreates: 0 }).failed_phase).toBe(
      'untimed'
    )
  })
})

describe('bucketWorktreeCount', () => {
  it.each([
    [0, '1'],
    [1, '1'],
    [2, '2-5'],
    [5, '2-5'],
    [6, '6-20'],
    [21, '21-100'],
    [101, '101-300'],
    [301, '301-1000'],
    [1000, '301-1000'],
    [1001, '1001+']
  ] as const)('%i worktrees -> %s', (count, bucket) => {
    expect(bucketWorktreeCount(count)).toBe(bucket)
  })
})
