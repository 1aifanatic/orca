import { getPersistedEditorOwnerFields } from '@/lib/editor-file-operation-owner'
import { toast } from 'sonner'
import type { EditorGet, EditorSet } from '../types/editor-set-get'
import { restoreRecentlyClosedTabPosition } from '../../recently-closed-tabs'
import { buildEditorActiveResult } from '../tabs/editor-open-target-group'
import { deferRecoveredEditorDraft } from './parked-recovered-editor-drafts'
import { editorDocumentPathOwnerKey } from '../file-ids/editor-document-identity'
import { recoveredDraftBlockedMessage } from './recovered-draft-block-notice'
import {
  canReuseLocalWslAlias,
  getReusableOpenFileModes,
  isSameEditorOwner,
  matchesEditorMode
} from '../file-ids/editor-file-ids'

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
  const { position, reopenId, dirtyDraftContent, ...snapshotFile } = next
  const file = { ...snapshotFile, ...getPersistedEditorOwnerFields(snapshotFile) }
  const collisionToast = (): void => {
    toast.info(recoveredDraftBlockedMessage('unsaved-rival', file))
  }
  const readOnlyCollisionToast = (): void => {
    toast.info(recoveredDraftBlockedMessage('read-only', file))
  }
  // Raise both the unified tab and its editor surface.
  const activateLiveRecord = (liveFileId: string): void => {
    get().setActiveFile(liveFileId)
    set((s) => buildEditorActiveResult(s, file.worktreeId, liveFileId))
  }
  // Keep newer live baselines; a missing baseline cannot authorize autosave.
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
    // Check collisions before openFile can reuse a live record or add a second tab.
    const beforeCollisionCheck = get()
    // Match openFile's reuse rule, which ignores readOnly and liveTail.
    const identity = editorDocumentPathOwnerKey(file)
    const modes = getReusableOpenFileModes(file.mode)
    const candidateIdentity = (
      candidate: (typeof beforeCollisionCheck.openFiles)[number]
    ): string =>
      editorDocumentPathOwnerKey({ ...candidate, ...getPersistedEditorOwnerFields(candidate) })
    // The normal open path can reuse an unstamped SSH tab; protect its captured owner first.
    const rivalOwner = beforeCollisionCheck.openFiles.find(
      (candidate) =>
        matchesEditorMode(candidate, modes) &&
        isSameEditorOwner(candidate, file.worktreeId, file.runtimeEnvironmentId) &&
        (candidate.filePath === file.filePath ||
          canReuseLocalWslAlias(
            beforeCollisionCheck,
            candidate,
            file,
            file.runtimeEnvironmentId
          )) &&
        candidateIdentity({ ...candidate, filePath: file.filePath }) !== identity
    )
    if (rivalOwner) {
      set((s) => deferRecoveredEditorDraft(s, worktreeId, next))
      toast.info(recoveredDraftBlockedMessage('other-owner', file))
      return true
    }
    const matches = beforeCollisionCheck.openFiles.filter(
      (candidate) =>
        matchesEditorMode(candidate, modes) && candidateIdentity(candidate) === identity
    )
    // Prefer a writable twin that can retain the draft.
    const live = matches.find((candidate) => candidate.readOnly !== true) ?? matches[0]
    const liveDraft = live ? beforeCollisionCheck.editorDrafts[live.id] : undefined
    if (live?.readOnly === true) {
      // A read-only record cannot retain this draft or its baseline.
      set((s) => deferRecoveredEditorDraft(s, worktreeId, next))
      activateLiveRecord(live.id)
      readOnlyCollisionToast()
      return true
    }
    if (live && liveDraft === dirtyDraftContent) {
      // Identical text must not replace a newer live baseline.
      adoptSnapshotDiskBaseline(live.id)
      activateLiveRecord(live.id)
      return true
    }
    if (live && (liveDraft !== undefined || live.isDirty === true)) {
      // Preserve the rival unsaved text for a later reopen.
      set((s) => deferRecoveredEditorDraft(s, worktreeId, next))
      activateLiveRecord(live.id)
      collisionToast()
      return true
    }
  }
  // Path aliases can still reuse a live record; preserve its draft before opening.
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
    // Reuse may select a read-only record, whose draft setters do nothing.
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
      // Identical text must not replace a newer live baseline.
      adoptSnapshotDiskBaseline(restoredFileId)
      return true
    }
    // Preserve the draft until the reused record can safely accept it.
    set((s) => deferRecoveredEditorDraft(s, worktreeId, next))
    collisionToast()
    return true
  }
  if (dirtyDraftContent !== undefined) {
    get().setEditorDraft(restoredFileId, dirtyDraftContent)
    get().markFileDirty(restoredFileId, true)
    // Verify the recovered draft's disk baseline before autosave resumes.
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
