import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import { useAgentCompletionCoordinatorLifecycle } from './agent-completion-coordinator-test-harness'
import { normalizeHookPayload } from '../../../../shared/agent-hook-listener'
import {
  createHookListenerState,
  seedLegacyAgentStatusForTests
} from '../../../../shared/agent-hook-listener/listener-state'
import {
  observeClaudeTranscript,
  syncClaudeTranscriptCursor
} from '../../../../shared/agent-hook-listener/providers/claude-transcript-watch'
import { makePaneKey } from '../../../../shared/stable-pane-id'

// Why: STA-4119's second complaint is the missing completion notification. This drives the REAL
// hook listener and feeds its real output into the REAL coordinator, rather than hand-writing a
// payload — the whole question is whether the two layers actually agree about a monitoring turn.
const PANE = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const RUNNING_SHELL = {
  id: 'shell-1',
  type: 'shell',
  status: 'running',
  description: 'Run the dev server',
  command: 'pnpm dev'
}

function hookPayload(
  state: ReturnType<typeof createHookListenerState>,
  payload: Record<string, unknown>
) {
  const parsed = normalizeHookPayload(
    state,
    'claude',
    { paneKey: PANE, payload },
    'production'
  )?.payload
  if (!parsed) {
    throw new Error('listener produced no payload')
  }
  // The hook server stamps stateStartedAt on the way to the renderer.
  return { ...parsed, stateStartedAt: 1_700_000_000_000 }
}

function createCoordinator() {
  const dispatchCompletion = vi.fn()
  const dispatchHookLifecycle = vi.fn()
  const coordinator = createAgentCompletionCoordinator({
    paneKey: PANE,
    getPtyId: () => 'pty-1',
    getSettings: () => null,
    inspectProcess: vi.fn(),
    dispatchCompletion,
    dispatchHookLifecycle,
    isLive: () => true
  })
  return { coordinator, dispatchCompletion, dispatchHookLifecycle }
}

/** Meta the coordinator hands the notification dispatcher. */
function completionMeta(dispatchCompletion: ReturnType<typeof vi.fn>) {
  return dispatchCompletion.mock.calls[0]?.[1] as
    | { source?: string; agentStatus?: { state?: string; workingMode?: string } }
    | undefined
}

describe('completion notification when a lead turn ends into monitoring', () => {
  useAgentCompletionCoordinatorLifecycle()

  it('announces completion when the turn ends but the pane stays working for a background shell', () => {
    const listener = createHookListenerState()
    const { coordinator, dispatchCompletion, dispatchHookLifecycle } = createCoordinator()

    coordinator.observeHookStatus(
      hookPayload(listener, { hook_event_name: 'UserPromptSubmit', prompt: 'start the dev server' })
    )
    const monitoring = hookPayload(listener, {
      hook_event_name: 'Stop',
      background_tasks: [RUNNING_SHELL]
    })

    // Precondition: the pane really is in the monitoring state, not done.
    expect(monitoring).toMatchObject({ state: 'working', workingMode: 'monitoring' })
    expect(typeof monitoring.turnCompletedAt).toBe('number')

    coordinator.observeHookStatus(monitoring)

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    const meta = completionMeta(dispatchCompletion)
    expect(meta?.source).toBe('hook')
    // Why: the announcement is a synthesized `done` while the reported row stays `working` —
    // the notification follows the TURN boundary, not the rendered state.
    expect(meta?.agentStatus?.state).toBe('done')
    // Why: announce only. Running pane lifecycle here would settle a pane that is still working.
    expect(dispatchHookLifecycle).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: 'done' })
    )
  })

  it('does not announce twice when the background shell later clears to done', () => {
    const listener = createHookListenerState()
    const { coordinator, dispatchCompletion } = createCoordinator()

    coordinator.observeHookStatus(
      hookPayload(listener, { hook_event_name: 'UserPromptSubmit', prompt: 'start the dev server' })
    )
    coordinator.observeHookStatus(
      hookPayload(listener, { hook_event_name: 'Stop', background_tasks: [RUNNING_SHELL] })
    )
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)

    // The shell exits; the same turn's all-clear must not re-announce.
    coordinator.observeHookStatus(
      hookPayload(listener, {
        hook_event_name: 'PostToolUse',
        tool_name: 'KillShell',
        background_tasks: []
      })
    )

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
  })

  it('does not announce again when Claude records a /tasks kill with no hook', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-completion-tasks-kill-'))
    try {
      const transcript = join(dir, 'session.jsonl')
      writeFileSync(transcript, '')
      const listener = createHookListenerState()
      const { coordinator, dispatchCompletion } = createCoordinator()
      // Shapes from the r1-s9 capture (claude-background-shell-tasks-kill-idle-hooks.jsonl).
      const hook = (payload: Record<string, unknown>) => {
        const event = normalizeHookPayload(
          listener,
          'claude',
          {
            paneKey: PANE,
            payload: {
              session_id: '00000000-0000-4000-8000-0000b2000000',
              transcript_path: transcript,
              ...payload
            }
          },
          'production'
        )
        if (!event) {
          throw new Error('listener produced no event')
        }
        return event
      }
      const observe = (payload: ReturnType<typeof hook>['payload']) =>
        coordinator.observeHookStatus({ ...payload, stateStartedAt: 1_700_000_000_000 })
      observe(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'start it' }).payload)
      observe(
        hook({
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_response: { backgroundTaskId: 'bmkj8eeoi' },
          tool_use_id: 'toolu_012Evdwg71Lm1f4XM5vSqWvf'
        }).payload
      )
      const stop = hook({
        hook_event_name: 'Stop',
        background_tasks: [{ id: 'bmkj8eeoi', type: 'shell', status: 'running' }]
      })
      observe(stop.payload)
      expect(dispatchCompletion).toHaveBeenCalledTimes(1)

      // The host stores the Stop's row and watches for the shell's end line.
      seedLegacyAgentStatusForTests(listener, stop)
      expect(syncClaudeTranscriptCursor(listener, stop)).toBe(true)
      appendFileSync(
        transcript,
        `${JSON.stringify({
          type: 'queue-operation',
          operation: 'enqueue',
          timestamp: '2026-09-29T05:24:58.227Z',
          content:
            '<task-notification>\n<task-id>bmkj8eeoi</task-id>\n<tool-use-id>toolu_012Evdwg71Lm1f4XM5vSqWvf</tool-use-id>\n<status>killed</status>\n<summary>Task "Sleep for 604 seconds" was stopped by the user</summary>\n</task-notification>'
        })}\n`
      )
      const observed = observeClaudeTranscript(listener, PANE)
      if (observed.kind !== 'read' || !observed.row) {
        throw new Error('the watch published no row')
      }
      expect(observed.row.payload).toMatchObject({
        state: 'done',
        turnCompletedAt: stop.payload.turnCompletedAt
      })
      observe(observed.row.payload)

      expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not announce mid-turn while the agent is still working in the foreground', () => {
    const listener = createHookListenerState()
    const { coordinator, dispatchCompletion } = createCoordinator()

    coordinator.observeHookStatus(
      hookPayload(listener, { hook_event_name: 'UserPromptSubmit', prompt: 'do the thing' })
    )
    coordinator.observeHookStatus(
      hookPayload(listener, { hook_event_name: 'PreToolUse', tool_name: 'Bash' })
    )

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })
})
