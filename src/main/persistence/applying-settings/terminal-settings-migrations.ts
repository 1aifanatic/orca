import type { GlobalSettings, OrcaWorkspaceLayout } from '../../../shared/global-settings-types'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import {
  legacyTerminalScrollbackBytesToRows,
  normalizeDesktopTerminalScrollbackRows
} from '../../../shared/terminal-scrollback-policy'
import {
  normalizeTuiAgentArgsRecord,
  normalizeTuiAgentEnvRecord
} from '../../../shared/tui-agent-launch-defaults'
import {
  isAgentPermissionMode,
  normalizeAgentPermissionModeOverrides,
  YOLO_TUI_AGENT_ARGS,
  YOLO_TUI_AGENT_ENV
} from '../../../shared/tui-agent-permissions'
import { liftComposedAgentLaunchProfile } from '../../../shared/agent-launch-profile-lift'

export function buildWorkspaceDirHistoryForUpdate(
  current: GlobalSettings,
  updates: Partial<GlobalSettings>
): OrcaWorkspaceLayout[] | null {
  if (!('workspaceDir' in updates) && !('nestWorkspaces' in updates)) {
    return null
  }
  const nextPath = updates.workspaceDir ?? current.workspaceDir
  const nextNestWorkspaces = updates.nestWorkspaces ?? current.nestWorkspaces
  if (
    normalizeRuntimePathForComparison(nextPath) ===
      normalizeRuntimePathForComparison(current.workspaceDir) &&
    nextNestWorkspaces === current.nestWorkspaces
  ) {
    return null
  }

  const previousLayout = {
    path: current.workspaceDir,
    nestWorkspaces: current.nestWorkspaces
  }
  const existing = current.workspaceDirHistory ?? []
  const next = [...existing]
  const previousKey = getWorkspaceLayoutHistoryKey(previousLayout)
  if (!next.some((layout) => getWorkspaceLayoutHistoryKey(layout) === previousKey)) {
    next.push(previousLayout)
  }
  return next
}

export type LegacyTerminalScrollbackSettings = {
  terminalScrollbackRows?: unknown
  terminalScrollbackBytes?: unknown
}

export const LEGACY_TERMINAL_TUI_SCROLL_SENSITIVITY_DEFAULT = 3

export function readLegacyTerminalScrollbackSettings(
  settings: unknown
): LegacyTerminalScrollbackSettings {
  return settings && typeof settings === 'object'
    ? (settings as LegacyTerminalScrollbackSettings)
    : {}
}

type RetiredGlobalSettings = {
  terminalScrollbackBytes?: unknown
  enableGitHubAttribution?: unknown
  showAgentsSidebar?: unknown
}

export function stripRetiredGlobalSettings(
  settings: Partial<GlobalSettings> | undefined
): Partial<GlobalSettings> {
  const {
    terminalScrollbackBytes: _legacyScrollbackBytes,
    enableGitHubAttribution: _legacyGitHubAttribution,
    showAgentsSidebar: _legacyShowAgentsSidebar,
    ...rest
  } = (settings ?? {}) as Partial<GlobalSettings> & RetiredGlobalSettings
  void _legacyScrollbackBytes
  void _legacyGitHubAttribution
  void _legacyShowAgentsSidebar
  return rest
}

export function migrateTerminalScrollbackRows(settings: unknown): {
  rows: number
  needsSave: boolean
} {
  const legacySettings = readLegacyTerminalScrollbackSettings(settings)
  const hasRows = Object.hasOwn(legacySettings, 'terminalScrollbackRows')
  const hasLegacyBytes = Object.hasOwn(legacySettings, 'terminalScrollbackBytes')
  const rows = hasRows
    ? normalizeDesktopTerminalScrollbackRows(legacySettings.terminalScrollbackRows)
    : legacyTerminalScrollbackBytesToRows(legacySettings.terminalScrollbackBytes)

  return {
    rows,
    needsSave: !hasRows || hasLegacyBytes || legacySettings.terminalScrollbackRows !== rows
  }
}

export function migrateTerminalTuiScrollSensitivityDefault(settings: GlobalSettings | undefined): {
  settings: Pick<
    GlobalSettings,
    'terminalTuiScrollSensitivity' | 'terminalTuiScrollSensitivityDefaultedToOne'
  >
  needsSave: boolean
} {
  const alreadyDefaultedToOne = settings?.terminalTuiScrollSensitivityDefaultedToOne === true
  const current = settings?.terminalTuiScrollSensitivity
  const shouldMoveInheritedDefault =
    !alreadyDefaultedToOne &&
    (current === undefined || current === LEGACY_TERMINAL_TUI_SCROLL_SENSITIVITY_DEFAULT)
  const terminalTuiScrollSensitivity = shouldMoveInheritedDefault ? 1 : (current ?? 1)

  return {
    settings: {
      terminalTuiScrollSensitivity,
      terminalTuiScrollSensitivityDefaultedToOne: true
    },
    needsSave: !alreadyDefaultedToOne || current === undefined
  }
}

export function getWorkspaceLayoutHistoryKey(layout: OrcaWorkspaceLayout): string {
  return `${normalizeRuntimePathForComparison(layout.path)}:${layout.nestWorkspaces}`
}

/** The launch arguments a profile saved before the permission mode was typed would have run with. */
function migrateAgentYoloDefaults(
  settings: GlobalSettings | undefined
): Pick<GlobalSettings, 'agentDefaultArgs' | 'agentDefaultEnv' | 'agentYoloDefaultsMigrated'> {
  const existingArgs = normalizeTuiAgentArgsRecord(settings?.agentDefaultArgs)
  const existingEnv = normalizeTuiAgentEnvRecord(settings?.agentDefaultEnv)
  if (existingArgs.devin === '--permission-mode bypass') {
    existingArgs.devin = YOLO_TUI_AGENT_ARGS.devin
  }
  if (settings?.agentYoloDefaultsMigrated === true) {
    // Keep newly added agents manual for profiles migrated by an older build.
    // Missing keys otherwise fall through to the current (possibly yolo) defaults.
    for (const agent of Object.keys(YOLO_TUI_AGENT_ARGS)) {
      if (!(agent in existingArgs)) {
        existingArgs[agent as keyof typeof YOLO_TUI_AGENT_ARGS] = ''
      }
    }
    for (const agent of Object.keys(YOLO_TUI_AGENT_ENV)) {
      if (!(agent in existingEnv)) {
        existingEnv[agent as keyof typeof YOLO_TUI_AGENT_ENV] = {}
      }
    }
    return {
      agentDefaultArgs: existingArgs,
      agentDefaultEnv: existingEnv,
      agentYoloDefaultsMigrated: true
    }
  }

  const commandOverrides = settings?.agentCmdOverrides ?? {}
  const migratedArgs = { ...existingArgs }
  for (const [agent, args] of Object.entries(YOLO_TUI_AGENT_ARGS)) {
    if (agent in migratedArgs) {
      continue
    }
    if (agent in commandOverrides) {
      migratedArgs[agent as keyof typeof YOLO_TUI_AGENT_ARGS] = ''
      continue
    }
    migratedArgs[agent as keyof typeof YOLO_TUI_AGENT_ARGS] = args
  }

  const migratedEnv = { ...existingEnv }
  for (const [agent, env] of Object.entries(YOLO_TUI_AGENT_ENV)) {
    if (agent in migratedEnv) {
      continue
    }
    if (agent in commandOverrides) {
      migratedEnv[agent as keyof typeof YOLO_TUI_AGENT_ENV] = {}
      continue
    }
    migratedEnv[agent as keyof typeof YOLO_TUI_AGENT_ENV] = { ...env }
  }

  return {
    // Why: legacy users could only customize launch defaults via command overrides, so those agents count as already user-owned.
    agentDefaultArgs: migratedArgs,
    agentDefaultEnv: migratedEnv,
    agentYoloDefaultsMigrated: true
  }
}

export type MigratedAgentLaunchProfile = Pick<
  GlobalSettings,
  | 'agentDefaultArgs'
  | 'agentDefaultEnv'
  | 'agentYoloDefaultsMigrated'
  | 'agentPermissionMode'
  | 'agentPermissionModeOverrides'
>

/**
 * Loads an agent launch profile as a typed permission mode plus the user's extra arguments.
 *
 * A stored `agentPermissionMode` marks a profile already in that shape, so this runs once and
 * re-running it is a no-op. Older profiles first get the yolo-defaults pass — which reads the flag
 * inline and keeps command-override users and the `agentYoloDefaultsMigrated` rule intact — and
 * then have that flag lifted out into the mode.
 */
export function migrateAgentLaunchProfile(settings: GlobalSettings | undefined): {
  profile: MigratedAgentLaunchProfile
  migrated: boolean
} {
  if (settings && isAgentPermissionMode(settings.agentPermissionMode)) {
    return {
      profile: {
        agentDefaultArgs: normalizeTuiAgentArgsRecord(settings.agentDefaultArgs),
        agentDefaultEnv: normalizeTuiAgentEnvRecord(settings.agentDefaultEnv),
        agentYoloDefaultsMigrated: true,
        agentPermissionMode: settings.agentPermissionMode,
        agentPermissionModeOverrides: normalizeAgentPermissionModeOverrides(
          settings.agentPermissionModeOverrides
        )
      },
      migrated: false
    }
  }
  return {
    profile: {
      ...liftComposedAgentLaunchProfile(migrateAgentYoloDefaults(settings)),
      agentYoloDefaultsMigrated: true
    },
    migrated: true
  }
}
