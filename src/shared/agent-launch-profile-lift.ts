import type { GlobalSettings } from './global-settings-types'
import { isTuiAgent } from './tui-agent-config'
import {
  composeTuiAgentLaunchArgsRecord,
  composeTuiAgentLaunchEnvRecord,
  normalizeTuiAgentArgsRecord,
  normalizeTuiAgentEnvRecord,
  resolveComposedTuiAgentLaunchArgs,
  resolveComposedTuiAgentLaunchEnv
} from './tui-agent-launch-defaults'
import {
  liftTuiAgentBypassArgs,
  liftTuiAgentBypassEnv,
  tuiAgentArgsSetPermissions
} from './tui-agent-permission-args'
import {
  PERMISSION_AGENT_IDS,
  resolveAgentPermissionMode,
  resolveDefaultAgentPermissionMode,
  YOLO_TUI_AGENT_ARGS,
  YOLO_TUI_AGENT_ENV,
  type AgentPermissionMode
} from './tui-agent-permissions'
import type { TuiAgent } from './tui-agent'

export type AgentLaunchProfile = Required<
  Pick<
    GlobalSettings,
    'agentDefaultArgs' | 'agentDefaultEnv' | 'agentPermissionMode' | 'agentPermissionModeOverrides'
  >
>

/**
 * Turns a launch-ready profile (flag inline) into a mode plus extra text, losslessly.
 * The majority mode becomes the default; a tie asks, so agents added later don't silently bypass.
 */
export function liftComposedAgentLaunchProfile(
  composed: Partial<Pick<GlobalSettings, 'agentDefaultArgs' | 'agentDefaultEnv'>> | null | undefined
): AgentLaunchProfile {
  const composedArgs = normalizeTuiAgentArgsRecord(composed?.agentDefaultArgs)
  // An older build shipped this shorter Devin bypass; it meant the same thing.
  if (composedArgs.devin === '--permission-mode bypass') {
    composedArgs.devin = YOLO_TUI_AGENT_ARGS.devin
  }
  const composedEnv = normalizeTuiAgentEnvRecord(composed?.agentDefaultEnv)
  const agentDefaultArgs = { ...composedArgs }
  const agentDefaultEnv = { ...composedEnv }
  const modes: Partial<Record<TuiAgent, AgentPermissionMode>> = {}
  for (const agent of PERMISSION_AGENT_IDS) {
    let bypass = false
    if (agent in YOLO_TUI_AGENT_ARGS) {
      const lifted = liftTuiAgentBypassArgs(
        agent,
        resolveComposedTuiAgentLaunchArgs(agent, composedArgs)
      )
      agentDefaultArgs[agent] = lifted.extraArgs
      bypass ||= lifted.bypass
    }
    if (agent in YOLO_TUI_AGENT_ENV) {
      const lifted = liftTuiAgentBypassEnv(
        agent,
        resolveComposedTuiAgentLaunchEnv(agent, composedEnv)
      )
      agentDefaultEnv[agent] = lifted.extraEnv
      bypass ||= lifted.bypass
    }
    modes[agent] = bypass ? 'bypass' : 'ask'
  }
  const bypassCount = Object.values(modes).filter((mode) => mode === 'bypass').length
  const agentPermissionMode: AgentPermissionMode =
    bypassCount * 2 > PERMISSION_AGENT_IDS.length ? 'bypass' : 'ask'
  const agentPermissionModeOverrides: Partial<Record<TuiAgent, AgentPermissionMode>> = {}
  for (const agent of PERMISSION_AGENT_IDS) {
    const mode = modes[agent]
    if (mode && mode !== agentPermissionMode) {
      agentPermissionModeOverrides[agent] = mode
    }
  }
  return { agentDefaultArgs, agentDefaultEnv, agentPermissionMode, agentPermissionModeOverrides }
}

/**
 * Applies a paired client's launch-ready args/env write. Only agents the write names change; an
 * older client that doesn't know an agent leaves that agent's mode and text alone.
 */
export function applyComposedAgentLaunchUpdate(
  current: Partial<
    Pick<
      GlobalSettings,
      | 'agentDefaultArgs'
      | 'agentDefaultEnv'
      | 'agentPermissionMode'
      | 'agentPermissionModeOverrides'
    >
  >,
  update: Partial<Pick<GlobalSettings, 'agentDefaultArgs' | 'agentDefaultEnv'>>
): Partial<
  Pick<GlobalSettings, 'agentDefaultArgs' | 'agentDefaultEnv' | 'agentPermissionModeOverrides'>
> {
  const writtenArgs = normalizeTuiAgentArgsRecord(update.agentDefaultArgs)
  const writtenEnv = normalizeTuiAgentEnvRecord(update.agentDefaultEnv)
  const lifted = liftComposedAgentLaunchProfile({
    agentDefaultArgs: { ...composeTuiAgentLaunchArgsRecord(current), ...writtenArgs },
    agentDefaultEnv: { ...composeTuiAgentLaunchEnvRecord(current), ...writtenEnv }
  })
  const defaultMode = resolveDefaultAgentPermissionMode(current)
  const agentPermissionModeOverrides: Partial<Record<TuiAgent, AgentPermissionMode>> = {}
  for (const agent of PERMISSION_AGENT_IDS) {
    const named = agent in writtenArgs || agent in writtenEnv
    // Text that sets permissions itself decides the launch, so it says nothing about the mode.
    const mode =
      named && !tuiAgentArgsSetPermissions(agent, lifted.agentDefaultArgs[agent])
        ? resolveAgentPermissionMode(agent, lifted)
        : resolveAgentPermissionMode(agent, current)
    if (mode !== defaultMode) {
      agentPermissionModeOverrides[agent] = mode
    }
  }
  return {
    ...(update.agentDefaultArgs !== undefined
      ? {
          agentDefaultArgs: {
            ...current.agentDefaultArgs,
            ...pickWritten(lifted.agentDefaultArgs, writtenArgs)
          }
        }
      : {}),
    ...(update.agentDefaultEnv !== undefined
      ? {
          agentDefaultEnv: {
            ...current.agentDefaultEnv,
            ...pickWritten(lifted.agentDefaultEnv, writtenEnv)
          }
        }
      : {}),
    agentPermissionModeOverrides
  }
}

/** The lifted entries for the agents a write named. */
function pickWritten<T>(
  lifted: Partial<Record<TuiAgent, T>>,
  written: Partial<Record<TuiAgent, unknown>>
): Partial<Record<TuiAgent, T>> {
  const picked: Partial<Record<TuiAgent, T>> = {}
  for (const agent of Object.keys(written)) {
    const value = isTuiAgent(agent) ? lifted[agent] : undefined
    if (isTuiAgent(agent) && value !== undefined) {
      picked[agent] = value
    }
  }
  return picked
}
