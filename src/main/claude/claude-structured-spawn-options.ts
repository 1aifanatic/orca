// A chat's saved options as the Claude child's launch options. The child starts already running
// them, so its first message can be written at once instead of waiting for initialize to answer and
// a control request to apply each one.

import type { EffortLevel, PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { AgentModelCatalogEntry } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { decodeStructuredAgentSessionOptionValue } from '../../shared/structured-agent-session-option-codec'
import {
  claudeStructuredOptionsBypassPermissions,
  claudeStructuredOptionsWithPermissionMode,
  type ClaudeStructuredLaunch,
  type ClaudeStructuredSdkOptions
} from './claude-structured-launch-resolution'
import type { ListedModel } from './claude-structured-model-catalog'
import type { ClaudeSession } from './claude-structured-session-state'
import { restoredClaudeStructuredSessionOptions } from './claude-structured-options'
import {
  claudeCatalogAdmitsModel,
  claudeModelEffortLevels,
  claudeModelFastModeSupport
} from './claude-structured-session-options'

const EFFORT_LEVELS: ReadonlySet<string> = new Set<EffortLevel>([
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
])
const PERMISSION_MODES: ReadonlySet<string> = new Set<PermissionMode>([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto'
])

function isEffortLevel(value: string): value is EffortLevel {
  return EFFORT_LEVELS.has(value)
}

function isPermissionMode(value: string): value is PermissionMode {
  return PERMISSION_MODES.has(value)
}

export type ClaudeStructuredSpawnOptions = {
  sdkOptions: ClaudeStructuredSdkOptions
  /** What the child was launched with, as the session's options. */
  options: Map<string, string>
  /** Saved options left out: the provider's own value wins and is re-persisted. */
  skipped: readonly string[]
}

/**
 * Checked against the account's cached catalog only, since nothing has been asked yet: a value
 * the cache rules out is left out, and with no cache entry every value passes. A value the CLI
 * itself would refuse at launch never passes: the start would fail on every reopen.
 */
export function claudeStructuredSpawnOptions(input: {
  launch: Pick<ClaudeStructuredLaunch, 'options' | 'resumesTranscript'>
  saved: Readonly<Record<string, string>> | undefined
  catalog: AgentModelCatalogEntry | null
}): ClaudeStructuredSpawnOptions {
  const saved = restoredClaudeStructuredSessionOptions(input.saved)
  const listed: ListedModel[] = (input.catalog?.models ?? []).map((model) => ({
    ...model,
    resolvedModel: null
  }))
  const options = new Map<string, string>()
  const skipped: string[] = []
  let sdkOptions: ClaudeStructuredSdkOptions = { ...input.launch.options }
  const model = saved.get('model')
  if (model !== undefined) {
    if (claudeCatalogAdmitsModel(listed, model)) {
      options.set('model', model)
      sdkOptions.model = model
    } else {
      skipped.push('model')
    }
  }
  const effort = saved.get('effort')
  if (effort !== undefined) {
    // With no saved model the CLI picks one this launch cannot name, so there is nothing to check.
    const { levels } = claudeModelEffortLevels(listed, options.get('model'))
    if (isEffortLevel(effort) && (!levels || levels.has(effort))) {
      options.set('effort', effort)
      sdkOptions.effort = effort
    } else {
      skipped.push('effort')
    }
  }
  const fastMode = saved.get('fastMode')
  if (fastMode !== undefined) {
    const decoded = decodeStructuredAgentSessionOptionValue('fastMode', fastMode)
    const support = claudeModelFastModeSupport(listed, options.get('model'))
    if (decoded === true && !input.launch.resumesTranscript) {
      // A fresh CLI session may be one whose settings opt in to Fast per session, which only the
      // CLI can say; it starts with Fast off rather than carry an opt-in it never made.
    } else if (
      typeof decoded !== 'boolean' ||
      (decoded && listed.length > 0 && support.supported !== true)
    ) {
      skipped.push('fastMode')
    } else {
      options.set('fastMode', fastMode)
      sdkOptions.settings = { fastMode: decoded }
    }
  }
  const permissionMode = saved.get('permissionMode')
  if (permissionMode !== undefined) {
    // Bypass is the Agent Permissions setting's to grant; a saved pick never widens it.
    if (
      isPermissionMode(permissionMode) &&
      (permissionMode !== 'bypassPermissions' ||
        claudeStructuredOptionsBypassPermissions(input.launch.options))
    ) {
      options.set('permissionMode', permissionMode)
      sdkOptions = claudeStructuredOptionsWithPermissionMode(sdkOptions, permissionMode)
    } else {
      skipped.push('permissionMode')
    }
  }
  return { sdkOptions, options, skipped }
}

/** The published session takes on what its child was launched with. */
export function adoptClaudeStructuredSpawnOptions(
  session: Pick<ClaudeSession, 'restoreSkippedOptions' | 'translator'>,
  spawn: Pick<ClaudeStructuredSpawnOptions, 'options' | 'skipped'>
): void {
  for (const key of spawn.skipped) {
    session.restoreSkippedOptions.add(key)
  }
  const model = spawn.options.get('model')
  if (model !== undefined) {
    session.translator?.modelWritten(model)
  }
  // The journal's window was measured under a value this child did not take.
  if (spawn.skipped.includes('model') || spawn.skipped.includes('permissionMode')) {
    session.translator?.modelMayHaveChanged()
  }
}
