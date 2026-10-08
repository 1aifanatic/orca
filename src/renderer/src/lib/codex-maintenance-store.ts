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
  verification: 'checking' | 'current' | 'unverifiable'
}
const EMPTY: CodexMaintenanceEntry = {
  state: null,
  starting: false,
  error: null,
  verification: 'unverifiable'
}
let entries: ReadonlyMap<string, CodexMaintenanceEntry> = new Map()
let logTarget: CodexMaintenanceTarget | null = null
const listeners = new Set<() => void>()
const reads = new Map<string, Promise<void>>()
const polls = new Map<string, ReturnType<typeof setTimeout>>()
const revisions = new Map<string, number>()
const starts = new Map<string, object>()
const hosts = new Map<string, string>()
const contexts = new Map<string, CodexMaintenanceTarget>()
const activities = new Map<
  string,
  Pick<CodexMaintenanceEntry, 'starting' | 'error'> & { job: CodexMaintenanceState['job'] }
>()
let revisionId = 0

function rememberTarget(target: CodexMaintenanceTarget): string {
  const key = codexMaintenanceTargetKey(target)
  hosts.set(key, codexMaintenanceTargetKey({ ...target, cwd: undefined }))
  contexts.set(key, target)
  return key
}

export function getCodexMaintenanceHostBusy(target: CodexMaintenanceTarget): boolean {
  const activity = activities.get(codexMaintenanceTargetKey({ ...target, cwd: undefined }))
  return Boolean(
    activity?.starting ||
    (!activity?.error &&
      activity?.job &&
      (activity.job.phase === 'queued' || activity.job.phase === 'running'))
  )
}

function nextRevision(key: string): number {
  const revision = ++revisionId
  revisions.set(key, revision)
  return revision
}

function publish(key: string, patch: Partial<CodexMaintenanceEntry>): void {
  const host = hosts.get(key)
  if (host) {
    const current = activities.get(host) ?? { starting: false, error: null, job: null }
    const job = patch.state?.job
    const running = current.job?.phase === 'running' || current.job?.phase === 'queued'
    activities.set(host, {
      starting: patch.starting ?? current.starting,
      error: patch.error === undefined ? current.error : patch.error,
      job: job !== undefined && (!running || job?.id === current.job?.id) ? job : current.job
    })
  }
  const next = new Map(entries).set(key, { ...getCodexMaintenanceEntry(key), ...patch })
  for (const [id, entry] of next) {
    if (next.size <= 64) {
      break
    }
    if (id !== key && !entry.starting && !polls.has(id)) {
      next.delete(id)
      revisions.delete(id)
      const oldHost = hosts.get(id)
      hosts.delete(id)
      contexts.delete(id)
      if (oldHost && ![...hosts.values()].includes(oldHost)) {
        activities.delete(oldHost)
      }
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
  const key = rememberTarget(target)
  clearTimeout(polls.get(key))
  polls.set(
    key,
    setTimeout(() => {
      polls.delete(key)
      if (starts.has(key)) {
        return
      }
      const revision = nextRevision(key)
      void callCodexMaintenance(target, { operation: 'read', jobId })
        .then((state) => {
          if (revisions.get(key) !== revision) {
            return
          }
          publish(key, { state, error: null, verification: 'current' })
          if (state.job && (state.job.phase === 'queued' || state.job.phase === 'running')) {
            scheduleRead(target, jobId)
          } else {
            refreshDetectedAgents(target)
            for (const [peerKey, peer] of contexts) {
              if (peerKey !== key && hosts.get(peerKey) === hosts.get(key)) {
                invalidateCodexMaintenanceContact(peer)
                void refreshCodexMaintenance(peer)
              }
            }
          }
        })
        .catch((error: unknown) => {
          if (revisions.get(key) !== revision) {
            return
          }
          publish(key, {
            error: error instanceof Error ? error.message : String(error),
            verification: 'unverifiable'
          })
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
  const key = rememberTarget(target)
  const pending = reads.get(key)
  if (getCodexMaintenanceEntry(key).starting) {
    return Promise.resolve()
  }
  if (pending) {
    return pending
  }
  const revision = nextRevision(key)
  publish(key, { verification: 'checking' })
  const read = callCodexMaintenance(target, { operation: 'status' })
    .then((state) => {
      if (revisions.get(key) !== revision) {
        return
      }
      publish(key, { state, error: null, verification: 'current' })
      if (state.job && (state.job.phase === 'queued' || state.job.phase === 'running')) {
        scheduleRead(target, state.job.id)
      }
    })
    .catch((error: unknown) => {
      if (revisions.get(key) !== revision) {
        return
      }
      // An unavailable host does not prove a missing or old CLI.
      publish(key, {
        error: error instanceof Error ? error.message : String(error),
        verification: 'unverifiable'
      })
    })
    .finally(() => {
      if (reads.get(key) === read) {
        reads.delete(key)
      }
    })
  reads.set(key, read)
  return read
}

export function invalidateCodexMaintenanceContact(target: CodexMaintenanceTarget): void {
  const key = rememberTarget(target)
  nextRevision(key)
  clearTimeout(polls.get(key))
  polls.delete(key)
  reads.delete(key)
  publish(key, { verification: 'unverifiable' })
}

export function startCodexMaintenance(target: CodexMaintenanceTarget): void {
  const key = rememberTarget(target)
  openCodexMaintenanceLog(target)
  const entry = getCodexMaintenanceEntry(key)
  if (entry.starting || activities.get(hosts.get(key) ?? '')?.starting) {
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
  clearTimeout(polls.get(key))
  polls.delete(key)
  const request = {}
  starts.set(key, request)
  publish(key, { starting: true, error: null, verification: 'checking' })
  const revision = nextRevision(key)
  void callCodexMaintenance(target, { operation: 'start' })
    .then((state) => {
      if (starts.get(key) !== request || revisions.get(key) !== revision) {
        return
      }
      const host = hosts.get(key)
      if (host) {
        activities.set(host, { starting: true, error: null, job: state.job })
      }
      publish(key, { state, verification: 'current' })
      if (state.job && (state.job.phase === 'queued' || state.job.phase === 'running')) {
        scheduleRead(target, state.job.id)
      }
    })
    .catch((error: unknown) => {
      if (revisions.get(key) !== revision) {
        return
      }
      publish(key, {
        error: error instanceof Error ? error.message : String(error),
        verification: 'unverifiable'
      })
    })
    .finally(() => {
      if (starts.get(key) === request) {
        starts.delete(key)
        publish(key, { starting: false })
        if (revisions.get(key) !== revision) {
          void refreshCodexMaintenance(target)
        }
      }
    })
}

export function resetCodexMaintenanceStoreForTests(): void {
  for (const timer of polls.values()) {
    clearTimeout(timer)
  }
  polls.clear()
  reads.clear()
  starts.clear()
  hosts.clear()
  contexts.clear()
  activities.clear()
  revisions.clear()
  entries = new Map()
  logTarget = null
}
