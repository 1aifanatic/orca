import {
  callCodexMaintenance,
  codexMaintenanceTargetKey,
  type CodexMaintenanceTarget
} from './codex-maintenance-client'
import type { CodexMaintenanceState } from '../../../shared/codex-cli-maintenance'
import { useAppStore } from '@/store'

export type CodexMaintenanceEntry = {
  state: CodexMaintenanceState | null
  starting: boolean
  error: string | null
}
const EMPTY: CodexMaintenanceEntry = { state: null, starting: false, error: null }
let entries: ReadonlyMap<string, CodexMaintenanceEntry> = new Map()
let logTarget: CodexMaintenanceTarget | null = null
const listeners = new Set<() => void>()
const reads = new Map<string, Promise<void>>()
const polls = new Map<string, ReturnType<typeof setTimeout>>()
const revisions = new Map<string, number>()
let revisionId = 0

function nextRevision(key: string): number {
  const revision = ++revisionId
  revisions.set(key, revision)
  return revision
}

function publish(key: string, patch: Partial<CodexMaintenanceEntry>): void {
  const next = new Map(entries).set(key, { ...getCodexMaintenanceEntry(key), ...patch })
  for (const [id, entry] of next) {
    if (next.size <= 64) {
      break
    }
    if (id !== key && !entry.starting && !polls.has(id)) {
      next.delete(id)
      revisions.delete(id)
    }
  }
  entries = next
  for (const listener of listeners) {
    listener()
  }
}

export function subscribeCodexMaintenance(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function getCodexMaintenanceEntry(key: string): CodexMaintenanceEntry {
  return entries.get(key) ?? EMPTY
}
export function getCodexMaintenanceLogTarget(): CodexMaintenanceTarget | null {
  return logTarget
}
export function openCodexMaintenanceLog(target: CodexMaintenanceTarget | null): void {
  logTarget = target
  for (const listener of listeners) {
    listener()
  }
}

function scheduleRead(target: CodexMaintenanceTarget, jobId: string, failures = 0): void {
  const key = codexMaintenanceTargetKey(target)
  clearTimeout(polls.get(key))
  polls.set(
    key,
    setTimeout(() => {
      polls.delete(key)
      const revision = nextRevision(key)
      void callCodexMaintenance(target, { operation: 'read', jobId })
        .then((state) => {
          if (revisions.get(key) !== revision) {
            return
          }
          publish(key, { state, error: null })
          if (state.job && (state.job.phase === 'queued' || state.job.phase === 'running')) {
            scheduleRead(target, jobId)
          } else {
            refreshDetectedAgents(target)
          }
        })
        .catch((error: unknown) => {
          if (revisions.get(key) !== revision) {
            return
          }
          publish(key, { error: error instanceof Error ? error.message : String(error) })
          if (failures < 2) {
            scheduleRead(target, jobId, failures + 1)
          }
        })
    }, 1_000)
  )
}

function refreshDetectedAgents(target: CodexMaintenanceTarget): void {
  const store = useAppStore.getState()
  const refresh =
    target.kind === 'ssh'
      ? store.refreshRemoteDetectedAgents(target.connectionId)
      : target.kind === 'environment'
        ? store.refreshRuntimeDetectedAgents(target.environmentId)
        : store.refreshDetectedAgents()
  void refresh.catch(() => {})
}

export function refreshCodexMaintenance(target: CodexMaintenanceTarget): Promise<void> {
  const key = codexMaintenanceTargetKey(target)
  const pending = reads.get(key)
  if (getCodexMaintenanceEntry(key).starting) {
    return Promise.resolve()
  }
  if (pending) {
    return pending
  }
  const revision = nextRevision(key)
  const read = callCodexMaintenance(target, { operation: 'status' })
    .then((state) => {
      if (revisions.get(key) !== revision) {
        return
      }
      publish(key, { state, error: null })
      if (state.job && (state.job.phase === 'queued' || state.job.phase === 'running')) {
        scheduleRead(target, state.job.id)
      }
    })
    .catch((error: unknown) => {
      if (revisions.get(key) !== revision) {
        return
      }
      // An unavailable host does not prove a missing or old CLI.
      publish(key, { error: error instanceof Error ? error.message : String(error) })
    })
    .finally(() => {
      reads.delete(key)
    })
  reads.set(key, read)
  return read
}

export function startCodexMaintenance(target: CodexMaintenanceTarget): void {
  const key = codexMaintenanceTargetKey(target)
  openCodexMaintenanceLog(target)
  const entry = getCodexMaintenanceEntry(key)
  if (entry.starting) {
    return
  }
  if (
    entry.state?.job &&
    (entry.state.job.phase === 'queued' || entry.state.job.phase === 'running') &&
    !entry.error
  ) {
    scheduleRead(target, entry.state.job.id)
    return
  }
  publish(key, { starting: true, error: null })
  const revision = nextRevision(key)
  void callCodexMaintenance(target, { operation: 'start' })
    .then((state) => {
      if (revisions.get(key) !== revision) {
        return
      }
      publish(key, { state })
      if (state.job && (state.job.phase === 'queued' || state.job.phase === 'running')) {
        scheduleRead(target, state.job.id)
      }
    })
    .catch((error: unknown) => {
      if (revisions.get(key) !== revision) {
        return
      }
      publish(key, { error: error instanceof Error ? error.message : String(error) })
    })
    .finally(() => {
      if (revisions.get(key) === revision) {
        publish(key, { starting: false })
      }
    })
}

export function resetCodexMaintenanceStoreForTests(): void {
  for (const timer of polls.values()) {
    clearTimeout(timer)
  }
  polls.clear()
  reads.clear()
  revisions.clear()
  entries = new Map()
  logTarget = null
}
