const revisionByEnvironmentId = new Map<string, number>()
const revisionChangeListeners = new Set<(environmentIds: readonly string[]) => void>()

export function replaceRuntimeEnvironmentRevisions(
  environments: readonly { id: string; createdAt: number; pairingRevision?: number }[]
): void {
  const previous = new Map(revisionByEnvironmentId)
  revisionByEnvironmentId.clear()
  for (const environment of environments) {
    revisionByEnvironmentId.set(
      environment.id,
      environment.pairingRevision ?? environment.createdAt
    )
  }
  const changed = [...previous].flatMap(([id, revision]) =>
    revisionByEnvironmentId.get(id) === revision ? [] : [id]
  )
  if (changed.length > 0) {
    for (const listener of revisionChangeListeners) {
      listener(changed)
    }
  }
}

/** Fires with the ids whose saved pairing moved or disappeared. */
export function onRuntimeEnvironmentRevisionsChanged(
  listener: (environmentIds: readonly string[]) => void
): () => void {
  revisionChangeListeners.add(listener)
  return () => revisionChangeListeners.delete(listener)
}

export function getRuntimeEnvironmentRevision(environmentId: string): number | undefined {
  return revisionByEnvironmentId.get(environmentId)
}

export function captureRuntimeEnvironmentRequestRevision(
  environmentId: string,
  expectedRevision?: number
): number | undefined {
  // Why: callers capture before awaits so a same-id re-pair cannot retarget their request.
  return expectedRevision ?? getRuntimeEnvironmentRevision(environmentId)
}
