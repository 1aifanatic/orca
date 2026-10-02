import type { GlobalSettings } from './global-settings-types'
import { isTuiAgent } from './tui-agent-config'
import {
  liftTuiAgentBypassArgs,
  liftTuiAgentBypassEnv,
  normalizeTuiAgentArgsRecord,
  normalizeTuiAgentEnvRecord,
  resolveComposedTuiAgentLaunchArgs,
  resolveComposedTuiAgentLaunchEnv
} from './tui-agent-launch-defaults'
import {
  PERMISSION_AGENT_IDS,
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
 * Turns a launch-ready profile — permission flag inline in each agent's arguments, the only shape
 * before the mode was typed and still the shape paired clients exchange — into a permission mode
 * plus the user's remaining text.
 *
 * Lossless: composing the result gives back the same options, with the flag moved to the front.
 * Agents that agree with the majority share the default; the rest become overrides, and a tie
 * defaults to asking so agents added later don't silently bypass.
 */
export function liftComposedAgentLaunchProfile(
  composed: Partial<Pick<GlobalSettings, 'agentDefaultArgs' | 'agentDefaultEnv'>> | null | undefined
): AgentLaunchProfile {
  const composedArgs = normalizeTuiAgentArgsRecord(composed?.agentDefaultArgs)
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
 * Applies a launch-ready `agentDefaultArgs`/`agentDefaultEnv` write — the shape paired clients
 * built before the mode was typed — to a typed profile: each agent it names gets the mode its
 * text implies and keeps only the rest of the text. Agents it does not name are untouched.
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
): Pick<GlobalSettings, 'agentDefaultArgs' | 'agentDefaultEnv' | 'agentPermissionModeOverrides'> {
  const agentDefaultArgs = { ...current.agentDefaultArgs }
  const agentDefaultEnv = { ...current.agentDefaultEnv }
  const agentPermissionModeOverrides = { ...current.agentPermissionModeOverrides }
  const defaultMode = resolveDefaultAgentPermissionMode(current)
  const setMode = (agent: TuiAgent, bypass: boolean): void => {
    const mode: AgentPermissionMode = bypass ? 'bypass' : 'ask'
    if (mode === defaultMode) {
      delete agentPermissionModeOverrides[agent]
    } else {
      agentPermissionModeOverrides[agent] = mode
    }
  }
  for (const [agent, args] of Object.entries(
    normalizeTuiAgentArgsRecord(update.agentDefaultArgs)
  )) {
    if (!isTuiAgent(agent)) {
      continue
    }
    const lifted = liftTuiAgentBypassArgs(agent, args)
    agentDefaultArgs[agent] = lifted.extraArgs
    if (agent in YOLO_TUI_AGENT_ARGS) {
      setMode(agent, lifted.bypass)
    }
  }
  for (const [agent, env] of Object.entries(normalizeTuiAgentEnvRecord(update.agentDefaultEnv))) {
    if (!isTuiAgent(agent)) {
      continue
    }
    const lifted = liftTuiAgentBypassEnv(agent, env)
    agentDefaultEnv[agent] = lifted.extraEnv
    if (agent in YOLO_TUI_AGENT_ENV) {
      setMode(agent, lifted.bypass)
    }
  }
  return { agentDefaultArgs, agentDefaultEnv, agentPermissionModeOverrides }
}
