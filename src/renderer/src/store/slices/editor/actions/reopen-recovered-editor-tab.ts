import { toast } from 'sonner'
import type { EditorGet, EditorSet } from '../types/editor-set-get'
import { restoreRecentlyClosedTabPosition } from '../../recently-closed-tabs'
import { buildEditorActiveResult } from '../tabs/editor-open-target-group'
import { deferRecoveredEditorDraft } from './parked-recovered-editor-drafts'
import { editorDocumentPathOwnerKey } from '../file-ids/editor-document-identity'
import { recoveredDraftBlockedMessage } from './recovered-draft-block-notice'
import { getReusableOpenFileModes, matchesEditorMode } from '../file-ids/editor-file-ids'

export function reopenRecoveredEditorTab(
  set: EditorSet,
  get: EditorGet,
  worktreeId: string
): boolean {
  const stack = get().recentlyClosedEditorTabsByWorktree[worktreeId] ?? []
  const next = stack[0]
  if (!next) {
    return false
  }
  set((s) => ({
    recentlyClosedEditorTabsByWorktree: {
      ...s.recentlyClosedEditorTabsByWorktree,
      [worktreeId]: (s.recentlyClosedEditorTabsByWorktree[worktreeId] ?? []).slice(1)
    }
  }))
  const { position, reopenId, dirtyDraftContent, ...file } = next
  const collisionToast = (): void => {
    toast.info(recoveredDraftBlockedMessage('unsaved-rival', file))
  }
  const readOnlyCollisionToast = (): void => {
    toast.info(recoveredDraftBlockedMessage('read-only', file))
  }
  // Why both halves: setActiveFile promotes the record's unified tab inside its group, and the
  // open-target result raises the editor surface the normal open path would have raised.
  const activateLiveRecord = (liveFileId: string): void => {
    get().setActiveFile(liveFileId)
    set((s) => buildEditorActiveResult(s, file.worktreeId, liveFileId))
  }
  // Why only when the record has none: a snapshot baseline older than the live record's would
  // manufacture a conflict, but a dirty record with no baseline at all is unverifiable.
  const adoptSnapshotDiskBaseline = (liveFileId: string): void => {
    const liveFile = get().openFiles.find((f) => f.id === liveFileId)
    if (!liveFile || liveFile.lastKnownDiskSignature !== undefined) {
      return
    }
    if (next.lastKnownDiskSignature === undefined) {
      get().setExternalMutation(liveFileId, 'changed')
      return
    }
    get().setLastKnownDiskSignature(liveFileId, next.lastKnownDiskSignature)
    get().setPendingDiskBaselineVerification(liveFileId, true)
  }
  if (dirtyDraftContent !== undefined) {
    // Why decided before the open: openFile would give the live record a second unified tab in
    // the snapshot's group, and the writes below would then land on the wrong document.
    const beforeCollisionCheck = get()
    // Why the surface-blind key: openFile's reuse rule ignores readOnly/liveTail, so a writable
    // snapshot whose identity key differs from a live read-only log still lands on that record.
    const identity = editorDocumentPathOwnerKey(file)
    const modes = getReusableOpenFileModes(file.mode)
    const matches = beforeCollisionCheck.openFiles.filter(
      (candidate) =>
        matchesEditorMode(candidate, modes) && editorDocumentPathOwnerKey(candidate) === identity
    )
    // Why writable first: a read-only twin only blocks the draft when nothing writable can hold it.
    const live = matches.find((candidate) => candidate.readOnly !== true) ?? matches[0]
    const liveDraft = live ? beforeCollisionCheck.editorDrafts[live.id] : undefined
    if (live?.readOnly === true) {
      // Why no open: openFile would reuse this record and hang a second unified tab off the
      // snapshot's group, and a read-only record can hold neither the draft nor its baseline.
      set((s) => deferRecoveredEditorDraft(s, worktreeId, next))
      activateLiveRecord(live.id)
      readOnlyCollisionToast()
      return true
    }
    if (live && liveDraft === dirtyDraftContent) {
      // Why nothing is written: the live record already holds this exact text, so the draft and
      // baseline writes would only replace a newer baseline with the snapshot's older one.
      adoptSnapshotDiskBaseline(live.id)
      activateLiveRecord(live.id)
      return true
    }
    if (live && (liveDraft !== undefined || live.isDirty === true)) {
      // Why deferred rather than dropped: the snapshot holds the only copy of that unsaved text.
      set((s) => deferRecoveredEditorDraft(s, worktreeId, next))
      // Why activate: the toast names a document the user must act on, so show it to them.
      activateLiveRecord(live.id)
      collisionToast()
      return true
    }
  }
  // Why captured before the open: openFile's reuse rule is coarser than the identity key above
  // (it also reuses across local/WSL path aliases), so a collision can still surface here.
  // Why targetGroupId is still passed: only that alias case can reuse a live record here, and
  // the snapshot's own group is where the user closed it from.
  const beforeOpen = get()
  const reusableRecordIds = new Set(beforeOpen.openFiles.map((f) => f.id))
  const draftsBeforeOpen = beforeOpen.editorDrafts
  const dirtyBeforeOpen = new Set(
    beforeOpen.openFiles.filter((f) => f.isDirty === true).map((f) => f.id)
  )
  let restoredFileId: string
  try {
    restoredFileId = get().openFile(file, {
      targetGroupId: position?.groupId,
      reopenId
    })
  } catch (error) {
    set((s) => deferRecoveredEditorDraft(s, worktreeId, next))
    throw error
  }
  if (
    dirtyDraftContent !== undefined &&
    get().openFiles.find((f) => f.id === restoredFileId)?.readOnly === true
  ) {
    // Why: openFile's reuse rule ignores readOnly, and setEditorDraft/markFileDirty hard no-op
    // on a read-only record — writing the draft below would consume the snapshot and lose it.
    set((s) => deferRecoveredEditorDraft(s, worktreeId, next))
    readOnlyCollisionToast()
    return true
  }
  const reusedLiveRecord = reusableRecordIds.has(restoredFileId)
  const reusedRecordHasUnsavedWork =
    reusedLiveRecord &&
    (draftsBeforeOpen[restoredFileId] !== undefined || dirtyBeforeOpen.has(restoredFileId))
  if (dirtyDraftContent !== undefined && reusedRecordHasUnsavedWork) {
    if (draftsBeforeOpen[restoredFileId] === dirtyDraftContent) {
      // Why nothing is written: the reused record already holds this exact text, so the draft
      // and baseline writes would only replace a newer baseline with the snapshot's older one.
      adoptSnapshotDiskBaseline(restoredFileId)
      return true
    }
    // Why put the snapshot back: its buffer has nowhere to restore to yet, and dropping it here
    // would destroy the only copy of that unsaved text.
    set((s) => deferRecoveredEditorDraft(s, worktreeId, next))
    collisionToast()
    return true
  }
  // Why: a live `OpenFile` has no dirtyDraftContent — only the hydration heal parks one on a
  // snapshot, for a record the restore could not give an id of its own. Reopen restores it.
  if (dirtyDraftContent !== undefined) {
    get().setEditorDraft(restoredFileId, dirtyDraftContent)
    get().markFileDirty(restoredFileId, true)
    // Why: the draft derives from the disk state this baseline was taken over, so the
    // restored-tab conflict scan must re-verify it before autosave resumes.
    if (next.lastKnownDiskSignature !== undefined) {
      get().setLastKnownDiskSignature(restoredFileId, next.lastKnownDiskSignature)
      get().setPendingDiskBaselineVerification(restoredFileId, true)
    } else {
      // No baseline means an automatic overwrite cannot be verified safe.
      get().setExternalMutation(restoredFileId, 'changed')
    }
  }
  restoreRecentlyClosedTabPosition(get, worktreeId, restoredFileId, position)
  return true
}
