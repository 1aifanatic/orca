import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { normalizeHookPayload } from '../../agent-hook-listener'
import { makePaneKey } from '../../stable-pane-id'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import { catchUpOnClaudeTranscript, syncClaudeTranscriptCursor } from './claude-transcript-watch'
import {
  claudePaneHasLaunchRecordedTask,
  claudePaneHasNonAgentWork,
  retireClaudeNonAgentTaskFromQueueRow
} from './claude-non-agent-work'

const PANE = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
// Shapes from the r1-s8k capture (Claude 2.1.284): the launching Bash call and TaskStop's result.
const LAUNCH = {
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'sleep 603', run_in_background: true },
  tool_response: {
    stdout: '',
    stderr: '',
    interrupted: false,
    isImage: false,
    noOutputExpected: false,
    backgroundTaskId: 'bjomx789i'
  },
  tool_use_id: 'toolu_013mmtuc5E5usx7f8rnbFEk9'
}
const TASK_STOP = {
  hook_event_name: 'PostToolUse',
  tool_name: 'TaskStop',
  tool_input: { task_id: 'bjomx789i' },
  tool_response: {
    message: 'Successfully stopped task: bjomx789i (sleep 603)',
    task_id: 'bjomx789i',
    task_type: 'local_bash',
    command: 'sleep 603'
  },
  tool_use_id: 'toolu_01BYd1WsdTmm53R5kToRn4oa'
}

function claudeEvent(state: HookListenerState, payload: Record<string, unknown>) {
  return normalizeHookPayload(state, 'claude', { paneKey: PANE, payload }, 'production')
}

/** The line shape Claude writes when a task ends (captured in claude-background-shell-*). */
function endLine(
  fields: { taskId?: string; toolUseId?: string; status?: string } = {},
  operation = 'enqueue'
): Record<string, unknown> {
  const { taskId = 'bjomx789i', toolUseId = LAUNCH.tool_use_id, status = 'killed' } = fields
  return {
    type: 'queue-operation',
    operation,
    timestamp: '2026-09-29T05:24:58.227Z',
    content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n<summary>Task "Sleep" was stopped by the user</summary>\n</task-notification>`
  }
}

function launched(): HookListenerState {
  const state = createHookListenerState()
  claudeEvent(state, { hook_event_name: 'UserPromptSubmit', prompt: 'start it' })
  expect(claudeEvent(state, LAUNCH)?.claudeRunningNonAgentTask).toBe(true)
  return state
}

describe('the Claude background task record', () => {
  it('records the launch with its tool call, and the stamp every row carries says so', () => {
    const state = launched()
    expect(state.claudeNonAgentWorkByPaneKey.get(PANE)?.tasks.get('bjomx789i')).toEqual({
      kind: 'unknown',
      launchToolUseId: LAUNCH.tool_use_id
    })
    expect(claudePaneHasLaunchRecordedTask(state, PANE)).toBe(true)
  })

  it("ignores a subagent's launch", () => {
    const state = createHookListenerState()
    claudeEvent(state, { ...LAUNCH, agent_id: 'a1', agent_type: 'general-purpose' })
    expect(claudePaneHasNonAgentWork(state, PANE)).toBe(false)
  })

  it("retires the task on TaskStop's result, under any of the tool's names", () => {
    for (const toolName of ['TaskStop', 'KillShell', 'KillBash']) {
      const state = launched()
      expect(
        claudeEvent(state, { ...TASK_STOP, tool_name: toolName })?.claudeRunningNonAgentTask
      ).toBe(false)
    }
  })

  it('lets a Stop inventory replace the record, typing the task and keeping its launch', () => {
    const state = launched()
    claudeEvent(state, {
      hook_event_name: 'Stop',
      background_tasks: [
        { id: 'bjomx789i', type: 'shell', status: 'running' },
        { id: 'bunlaunch', type: 'monitor', status: 'running' }
      ]
    })
    const tasks = state.claudeNonAgentWorkByPaneKey.get(PANE)?.tasks
    expect(tasks?.get('bjomx789i')).toEqual({
      kind: 'command',
      launchToolUseId: LAUNCH.tool_use_id
    })
    expect(tasks?.get('bunlaunch')).toEqual({ kind: 'monitor' })
    claudeEvent(state, { hook_event_name: 'Stop', background_tasks: [] })
    expect(claudePaneHasNonAgentWork(state, PANE)).toBe(false)
  })

  it('holds unnamed running work, and work past the id cap, until an inventory clears it', () => {
    const state = createHookListenerState()
    claudeEvent(state, {
      hook_event_name: 'Stop',
      background_tasks: [
        { type: 'shell', status: 'running' },
        ...Array.from({ length: 70 }, (_, index) => ({
          id: `b${index}`,
          type: 'shell',
          status: 'running'
        }))
      ]
    })
    const work = state.claudeNonAgentWorkByPaneKey.get(PANE)
    expect(work?.tasks.size).toBe(64)
    expect(work?.hasUnnamedRunning).toBe(true)
    claudeEvent(state, { hook_event_name: 'Stop', background_tasks: [] })
    expect(state.claudeNonAgentWorkByPaneKey.has(PANE)).toBe(false)
  })

  it('keeps the record across a new session in the pane: a shell survives /clear', () => {
    const state = launched()
    claudeEvent(state, {
      hook_event_name: 'SessionStart',
      source: 'clear',
      session_id: '00000000-0000-4000-8000-0000000000c1'
    })
    expect(claudePaneHasLaunchRecordedTask(state, PANE)).toBe(true)
  })
})

describe('the task end line in the transcript', () => {
  it('retires the task only for its launch-recorded task id and tool call', () => {
    const state = launched()
    expect(
      retireClaudeNonAgentTaskFromQueueRow(state, PANE, endLine({ toolUseId: 'toolu_other' }))
    ).toBe(false)
    expect(retireClaudeNonAgentTaskFromQueueRow(state, PANE, endLine({ taskId: 'bother' }))).toBe(
      false
    )
    expect(retireClaudeNonAgentTaskFromQueueRow(state, PANE, endLine())).toBe(true)
    expect(claudePaneHasNonAgentWork(state, PANE)).toBe(false)
  })

  it('never retires on typed text, a running status, a removal, or two notifications in one line', () => {
    const state = launched()
    const matched = endLine()
    // Captured (r3-typed-run1): a prompt typed while Claude is busy writes this row shape.
    const typed = { ...matched, content: 'Capture step 2: reply with exactly the word QUEUED.' }
    const twice = { ...matched, content: `${matched.content}\n${matched.content}` }
    for (const line of [
      typed,
      endLine({ status: 'running' }),
      endLine({}, 'remove'),
      twice,
      { ...matched, type: 'user' }
    ]) {
      expect(retireClaudeNonAgentTaskFromQueueRow(state, PANE, line)).toBe(false)
    }
    expect(claudePaneHasLaunchRecordedTask(state, PANE)).toBe(true)
  })

  it('leaves a task only an inventory named (no recorded launch) for the next inventory', () => {
    const state = createHookListenerState()
    claudeEvent(state, {
      hook_event_name: 'Stop',
      background_tasks: [{ id: 'bjomx789i', type: 'shell', status: 'running' }]
    })
    expect(claudePaneHasLaunchRecordedTask(state, PANE)).toBe(false)
    expect(retireClaudeNonAgentTaskFromQueueRow(state, PANE, endLine())).toBe(false)
    expect(claudePaneHasNonAgentWork(state, PANE)).toBe(true)
  })
})

describe('watching for the end line', () => {
  it('parses only queue-operation lines that carry a notification, never the per-turn snapshot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-background-shell-watch-'))
    try {
      const transcript = join(dir, 'session.jsonl')
      writeFileSync(transcript, '')
      const state = createHookListenerState()
      claudeEvent(state, { hook_event_name: 'UserPromptSubmit', prompt: 'start it' })
      const event = claudeEvent(state, {
        ...LAUNCH,
        session_id: '00000000-0000-4000-8000-0000000000d1',
        transcript_path: transcript
      })
      if (!event) {
        throw new Error('listener produced no event')
      }
      expect(syncClaudeTranscriptCursor(state, event)).toBe(true)
      // Hand-built at the size of the per-turn prompt_snapshot attachment, which quotes the tag.
      const snapshot = JSON.stringify({
        type: 'attachment',
        text: `<task-notification> ${'x'.repeat(56 * 1024)}`
      })
      appendFileSync(transcript, `${snapshot}\n${JSON.stringify(endLine())}\n`)
      const parse = vi.spyOn(JSON, 'parse')
      catchUpOnClaudeTranscript(state, PANE)
      expect(parse).toHaveBeenCalledTimes(1)
      parse.mockRestore()
      expect(claudePaneHasNonAgentWork(state, PANE)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
