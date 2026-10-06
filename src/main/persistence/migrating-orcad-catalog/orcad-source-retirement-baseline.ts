/**
 * Exactly which rows a migration's retirement may remove or rewrite, as path → digests. Recorded
 * durably before anything is deleted, it is the only authority a later attempt has: a row whose
 * current value is not in it is a user's write since, and retirement keeps it.
 */
import { createHash } from 'node:crypto'
import {
  serializeOrcadMigrationValue,
  type OrcadMigrationManifest
} from '../../../shared/orcad-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { retireOrcadSourceCatalogState } from './orcad-source-catalog-retirement'
import { retargetOrcadSourceClientFocus } from './orcad-source-client-focus-retarget'
import { retireOrcadMigrationSourceDormantState } from './orcad-source-dormant-retirement'
import { retireOrcadSourceReconnectHint } from './orcad-source-workspace-session-retirement'

/** `field|key|…` to the digests of every value retirement would remove or rewrite there. */
export type OrcadRetirementRows = Map<string, Set<string>>

const MAX_DEPTH = 6

/** Every change retirement makes to profile state; the store adds only derived bookkeeping. */
export function applyOrcadSourceRetirement(
  state: PersistedState,
  manifest: OrcadMigrationManifest
): void {
  retireOrcadSourceCatalogState(state, manifest)
  retargetOrcadSourceClientFocus(state, manifest)
  retireOrcadMigrationSourceDormantState(state, manifest)
  retireOrcadSourceReconnectHint(state, manifest.source.sshTargetId)
}

/** What retirement would touch now, worked out on a copy. */
export function collectOrcadRetirementRows(
  state: PersistedState,
  manifest: OrcadMigrationManifest
): OrcadRetirementRows {
  const after = structuredClone(state)
  applyOrcadSourceRetirement(after, manifest)
  return diffRows(state, after)
}

/**
 * Each manifest's rows, retiring them in order on one copy, so a later step's baseline is the
 * state the earlier steps leave rather than rows they already rewrote.
 */
export function collectOrcadRetirementBaselines(
  state: PersistedState,
  manifests: readonly OrcadMigrationManifest[]
): Map<string, OrcadRetirementRows> {
  const baselines = new Map<string, OrcadRetirementRows>()
  let current = structuredClone(state)
  for (const manifest of manifests) {
    const after = structuredClone(current)
    applyOrcadSourceRetirement(after, manifest)
    baselines.set(manifest.migrationId, diffRows(current, after))
    current = after
  }
  return baselines
}

/** Paths whose current value the baseline does not authorize, sorted for a stable report. */
export function unauthorizedOrcadRetirementRows(
  current: OrcadRetirementRows,
  baseline: Readonly<Record<string, readonly string[]>>
): string[] {
  return [...current]
    .filter(([path, digests]) => [...digests].some((digest) => !baseline[path]?.includes(digest)))
    .map(([path]) => path)
    .sort()
}

export function serializeOrcadRetirementRows(rows: OrcadRetirementRows): Record<string, string[]> {
  return Object.fromEntries([...rows].map(([path, digests]) => [path, [...digests].sort()]))
}

function diffRows(before: PersistedState, after: PersistedState): OrcadRetirementRows {
  const rows: OrcadRetirementRows = new Map()
  const record = (path: string, value: unknown): void => {
    const digests = rows.get(path) ?? new Set<string>()
    digests.add(digestOf(value))
    rows.set(path, digests)
  }
  const beforeFields = new Map<string, unknown>(Object.entries(before))
  const afterFields = new Map<string, unknown>(Object.entries(after))
  for (const key of new Set([...beforeFields.keys(), ...afterFields.keys()])) {
    const left = beforeFields.get(key)
    const right = afterFields.get(key)
    if (key === 'workspaceSession') {
      // Why no partition in the path: a stale copy saved into another partition is the same row.
      diffValue('session', left, right, MAX_DEPTH, record)
    } else if (key === 'workspaceSessionsByHostId') {
      const leftHosts = asRecord(left)
      const rightHosts = asRecord(right)
      for (const host of new Set([...Object.keys(leftHosts), ...Object.keys(rightHosts)])) {
        diffValue('session', leftHosts[host], rightHosts[host], MAX_DEPTH, record)
      }
    } else {
      diffValue(key, left, right, MAX_DEPTH, record)
    }
  }
  return rows
}

function diffValue(
  path: string,
  before: unknown,
  after: unknown,
  depth: number,
  record: (path: string, value: unknown) => void
): void {
  if (
    serializeOrcadMigrationValue(before ?? null) === serializeOrcadMigrationValue(after ?? null)
  ) {
    return
  }
  if (depth > 0 && isRecord(before) && isRecord(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      diffValue(`${path}|${key}`, before[key], after[key], depth - 1, record)
    }
    return
  }
  if (depth > 0 && isIdentifiedArray(before) && (after === undefined || isIdentifiedArray(after))) {
    const afterById = new Map((after ?? []).map((entry) => [entry.id, entry]))
    for (const entry of before) {
      diffValue(`${path}|#${entry.id}`, entry, afterById.get(entry.id), 0, record)
    }
    return
  }
  record(path, before)
}

function digestOf(value: unknown): string {
  return createHash('sha256')
    .update(serializeOrcadMigrationValue(value ?? null))
    .digest('hex')
    .slice(0, 32)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function isIdentifiedArray(value: unknown): value is { id: string }[] {
  return (
    Array.isArray(value) && value.every((entry) => isRecord(entry) && typeof entry.id === 'string')
  )
}
