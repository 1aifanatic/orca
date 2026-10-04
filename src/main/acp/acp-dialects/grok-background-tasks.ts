import { z } from 'zod'
import {
  isSettledBackgroundTaskState,
  normalizeBackgroundTaskKind
} from '../../../shared/native-chat-background-task-row'
import type { NativeChatBackgroundTaskBlock } from '../../../shared/native-chat-types'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import type { AcpBackgroundTaskUpdate, AcpDialectNotification } from './acp-dialect'

const taskSchema = z.object({
  task_id: z.string().min(1),
  command: z.string().optional(),
  description: z.string().nullish(),
  monitor_description: z.string().nullish(),
  display_command: z.string().nullish(),
  output_file: z.string().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  output: z.string().optional(),
  kind: z.string().optional(),
  task_type: z.string().optional(),
  exit_code: z.number().int().nullish(),
  signal: z.union([z.string(), z.number()]).nullish(),
  explicitly_killed: z.boolean().optional()
})
const backgroundedSchema = taskSchema.extend({
  sessionUpdate: z.literal('task_backgrounded'),
  tool_call_id: z.string().optional()
})
const completedSchema = z.object({
  sessionUpdate: z.literal('task_completed'),
  task_snapshot: taskSchema
})
const startedOutputSchema = taskSchema.extend({ type: z.literal('BackgroundTaskStarted') })
type GrokTask = z.infer<typeof taskSchema>

function snapshot(
  task: GrokTask,
  state: NativeChatBackgroundTaskBlock['state']
): AcpBackgroundTaskUpdate {
  const kind = task.kind ?? task.task_type
  const monitor = kind === 'monitor' || task.monitor_description != null
  const label = task.monitor_description ?? task.description ?? task.display_command ?? task.command
  return {
    taskId: task.task_id,
    state,
    ...(monitor
      ? { kind: 'monitor' as const }
      : kind !== undefined || task.command !== undefined
        ? {
            kind:
              kind === 'bash' || kind === 'shell' || task.command !== undefined
                ? ('command' as const)
                : normalizeBackgroundTaskKind(kind ?? 'unknown')
          }
        : {}),
    ...(label === undefined ? {} : { label }),
    ...(task.output_file === undefined ? {} : { outputFile: task.output_file }),
    ...(task.summary === undefined &&
    task.output === undefined &&
    !isSettledBackgroundTaskState(state)
      ? {}
      : { summary: task.summary ?? task.output ?? '' }),
    ...(task.error === undefined && !isSettledBackgroundTaskState(state)
      ? {}
      : { error: task.error ?? '' })
  }
}

export function grokToolBackgroundTasks(update: ToolCallUpdate): AcpBackgroundTaskUpdate[] {
  const parsed = startedOutputSchema.safeParse(update.rawOutput)
  return parsed.success
    ? [{ ...snapshot(parsed.data, 'working'), parentToolUseId: update.toolCallId }]
    : []
}

export function grokBackgroundTaskNotification(
  canonicalMethod: string,
  params: unknown
): AcpDialectNotification | undefined {
  if (!['x.ai/task_backgrounded', 'x.ai/task_completed'].includes(canonicalMethod)) {
    return undefined
  }
  const parsed = z
    .object({ update: z.union([backgroundedSchema, completedSchema]) })
    .safeParse(params)
  if (!parsed.success) {
    return { disposition: 'ignore' }
  }
  const update = parsed.data.update
  if (update.sessionUpdate === 'task_backgrounded') {
    return {
      disposition: 'map',
      backgroundTasks: [
        {
          ...snapshot(update, update.monitor_description != null ? 'monitoring' : 'working'),
          ...(update.tool_call_id === undefined ? {} : { parentToolUseId: update.tool_call_id })
        }
      ]
    }
  }
  const task = update.task_snapshot
  const state = task.explicitly_killed
    ? 'idle'
    : task.signal != null || (task.exit_code != null && task.exit_code !== 0)
      ? 'blocked'
      : task.exit_code === 0
        ? 'done'
        : 'unverifiable'
  return { disposition: 'map', backgroundTasks: [snapshot(task, state)] }
}
