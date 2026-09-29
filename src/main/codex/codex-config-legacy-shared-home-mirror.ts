import { join } from 'node:path'
import {
  recoverInterruptedGuardedFileOperation,
  writeFileAtomicallyIfUnchanged
} from '../codex-accounts/fs-utils'
import { observeAgentStateFile } from './codex-path-observation'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from './codex-home-paths'
import type { CodexSettingsPromotionHomes } from './config-settings-promotion'
import { applyCodexDaemonSocketGuard } from './codex-daemon-socket-path-guard'
import {
  applyUnparseableCodexSourceRule,
  backUpDiscardedManagedConfig,
  findUnparseableManagedCodexConfig,
  isVerbatimCodexSourceCopy,
  refuseUnparseableManagedConfig
} from './codex-managed-config-validity'
import { mergeSystemCodexConfigIntoRuntime } from './codex-config-mirror-merge'
import {
  prepareSystemConfigForFreshRuntimeMirror,
  prepareSystemConfigForRuntimeMirror,
  resolveCodexConfigMirrorSourceDirectory
} from './codex-config-mirror-source'

/**
 * Refreshes the retired shared home for PTYs that survived real-home rollout.
 *
 * This is deliberately one-way: a retained PTY may hold pre-rollout settings,
 * so treating that home as a promotion source could overwrite the live config.
 */
export function syncSystemConfigIntoLegacySharedCodexHome(
  homes: CodexSettingsPromotionHomes = {
    runtimeHomePath: getOrcaManagedCodexHomePath(),
    systemHomePath: getSystemCodexHomePath()
  }
): void {
  const systemConfigPath = join(homes.systemHomePath, 'config.toml')
  const runtimeConfigPath = join(homes.runtimeHomePath, 'config.toml')
  recoverInterruptedGuardedFileOperation(runtimeConfigPath)
  const systemConfigObservation = observeAgentStateFile(systemConfigPath)
  if (systemConfigObservation.kind === 'indeterminate') {
    throw systemConfigObservation.error
  }
  const rawSystemConfig =
    systemConfigObservation.kind === 'present' ? systemConfigObservation.value : ''
  const runtimeConfigObservation = observeAgentStateFile(runtimeConfigPath)
  if (runtimeConfigObservation.kind === 'indeterminate') {
    throw runtimeConfigObservation.error
  }
  const runtimeConfigBeforeMirror =
    runtimeConfigObservation.kind === 'present' ? runtimeConfigObservation.value : null
  if (
    applyUnparseableCodexSourceRule({
      sourcePath: systemConfigPath,
      runtimeConfigPath,
      source: rawSystemConfig,
      runtime: runtimeConfigBeforeMirror,
      writeVerbatimCopy: (copy) =>
        writeFileAtomicallyIfUnchanged(runtimeConfigPath, runtimeConfigBeforeMirror, copy)
    })
  ) {
    return
  }
  const runtimeParses =
    runtimeConfigBeforeMirror !== null &&
    findUnparseableManagedCodexConfig(runtimeConfigBeforeMirror) === null
  // Why: a missing cloud-synced source is not proof the user cleared config,
  // but Orca's copy of a since-removed broken source holds nothing to keep.
  let mirroredRuntimeConfig =
    runtimeConfigBeforeMirror !== null && !isVerbatimCodexSourceCopy(runtimeConfigBeforeMirror)
      ? runtimeConfigBeforeMirror
      : ''
  if (rawSystemConfig.trim() !== '') {
    const sourceConfigDir = resolveCodexConfigMirrorSourceDirectory(homes.systemHomePath)
    // The retired home has no ownership baseline; its entire MCP root stays canonical.
    // Why: sections are never carried out of a managed config Codex cannot parse.
    mirroredRuntimeConfig =
      runtimeConfigBeforeMirror !== null && runtimeParses
        ? mergeSystemCodexConfigIntoRuntime(
            runtimeConfigBeforeMirror,
            prepareSystemConfigForRuntimeMirror(rawSystemConfig, sourceConfigDir),
            new Set(),
            true
          )
        : prepareSystemConfigForFreshRuntimeMirror(rawSystemConfig, sourceConfigDir)
  }
  // Why: retained pre-rollout panes still use this home, so a refresh must keep the daemon guard.
  const nextRuntimeConfig = applyCodexDaemonSocketGuard(
    mirroredRuntimeConfig,
    homes.runtimeHomePath
  )
  if (
    (runtimeConfigBeforeMirror ?? '') === nextRuntimeConfig ||
    refuseUnparseableManagedConfig(runtimeConfigPath, nextRuntimeConfig)
  ) {
    return
  }
  if (rawSystemConfig.trim() !== '') {
    backUpDiscardedManagedConfig({
      sourcePath: systemConfigPath,
      runtimeConfigPath,
      source: rawSystemConfig,
      discarded: runtimeConfigBeforeMirror
    })
  }
  // Why: stage first, then compare immediately before replace so a retained
  // Codex trust write during mirror preparation wins.
  writeFileAtomicallyIfUnchanged(runtimeConfigPath, runtimeConfigBeforeMirror, nextRuntimeConfig)
}
