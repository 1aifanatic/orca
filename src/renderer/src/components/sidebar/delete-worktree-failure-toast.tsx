import { toast } from 'sonner'
import { useId, useState } from 'react'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { Label } from '../ui/label'
import { getDeleteWorktreeToastCopy } from './delete-worktree-toast'
import { translate } from '@/i18n/i18n'
import { DeleteNestedWorktreesDialog } from './DeleteNestedWorktreesDialog'
import { isNestedWorktreeRemovalError } from '../../../../shared/worktree/nested-removal'
import {
  isLockedWorktreeRemovalError,
  type WorktreeForceDeleteReason,
  type WorktreeRemovalTarget
} from '../../../../shared/worktree/removal'

type DeleteWorktreeFailureToastOptions = {
  error: string
  canForceDelete: boolean
  forceDeleteReason: WorktreeForceDeleteReason | null
  lockReason?: string | null
  hasKnownChanges?: boolean
  /** The archive hook refused this removal, so the user may waive it (#19334). */
  canWaiveArchiveHook?: boolean
  onViewChanges: () => void
  onForceDelete: () => void
  onAlwaysForceDelete?: () => Promise<void>
  onDeleteAnyway: () => void
  worktreeId: string
  worktreeName: string
  nestedRemovalTarget?: WorktreeRemovalTarget
  onNestedDeleted?: () => void
}

function deleteWorktreeFailureToastId(worktreeId: string): string {
  return `delete-worktree-failure:${worktreeId}`
}

function DeleteWorktreeFailureToastBody({
  description,
  canForceDelete,
  canWaiveArchiveHook,
  showViewChanges,
  onViewChanges,
  onForceDelete,
  onAlwaysForceDelete,
  onDeleteAnyway,
  toastId,
  nestedRemovalTarget,
  worktreeName,
  onNestedDeleted
}: {
  description?: string
  canForceDelete: boolean
  canWaiveArchiveHook: boolean
  showViewChanges: boolean
  onViewChanges: () => void
  onForceDelete: () => void
  onAlwaysForceDelete?: () => Promise<void>
  onDeleteAnyway: () => void
  toastId: string
  nestedRemovalTarget?: WorktreeRemovalTarget
  worktreeName: string
  onNestedDeleted?: () => void
}): React.JSX.Element {
  const preferenceId = useId()
  const [alwaysForceDelete, setAlwaysForceDelete] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const viewChanges = (): void => {
    toast.dismiss(toastId)
    onViewChanges()
  }
  const forceDelete = async (): Promise<void> => {
    if (alwaysForceDelete && onAlwaysForceDelete) {
      setIsSaving(true)
      try {
        await onAlwaysForceDelete()
      } catch (error) {
        setIsSaving(false)
        toast.error(
          translate('workspaceDeletion.preferenceSaveFailed', 'Could not save deletion preference'),
          { description: error instanceof Error ? error.message : String(error) }
        )
        return
      }
    }
    toast.dismiss(toastId)
    onForceDelete()
  }
  const deleteAnyway = (): void => {
    toast.dismiss(toastId)
    onDeleteAnyway()
  }

  return (
    <div className="flex w-full flex-col gap-3">
      {description ? (
        <p className="text-sm leading-5 text-popover-foreground/80">{description}</p>
      ) : null}
      {canForceDelete && onAlwaysForceDelete ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <Checkbox
              id={preferenceId}
              checked={alwaysForceDelete}
              disabled={isSaving}
              onCheckedChange={(checked) => setAlwaysForceDelete(checked === true)}
              aria-describedby={`${preferenceId}-description`}
            />
            <Label htmlFor={preferenceId}>
              {translate('workspaceDeletion.alwaysForceDelete', 'Always force delete')}
            </Label>
          </div>
          <p id={`${preferenceId}-description`} className="text-xs text-muted-foreground">
            {translate(
              'workspaceDeletion.alwaysForceDeleteDescription',
              'Future deletions discard changes, even if terminal shutdown cannot be verified. Change this in Settings.'
            )}
          </p>
        </div>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        {showViewChanges ? (
          <Button type="button" variant="outline" size="sm" onClick={viewChanges}>
            {translate('auto.components.sidebar.delete.worktree.flow.7488ed8711', 'View')}
          </Button>
        ) : null}
        {nestedRemovalTarget ? (
          <DeleteNestedWorktreesDialog
            target={nestedRemovalTarget}
            worktreeName={worktreeName}
            onDeleted={onNestedDeleted}
            dismissToast={() => toast.dismiss(toastId)}
          />
        ) : null}
        {canForceDelete ? (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={isSaving}
            onClick={forceDelete}
          >
            {translate('auto.components.sidebar.delete.worktree.flow.2b20ce87b3', 'Force Delete')}
          </Button>
        ) : null}
        {canWaiveArchiveHook ? (
          <Button type="button" variant="destructive" size="sm" onClick={deleteAnyway}>
            {translate(
              'auto.components.sidebar.delete.worktree.failure.archive.waiver',
              'Delete Anyway'
            )}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

export function showDeleteWorktreeFailureToast({
  error,
  canForceDelete,
  forceDeleteReason,
  lockReason,
  hasKnownChanges,
  canWaiveArchiveHook,
  onViewChanges,
  onForceDelete,
  onAlwaysForceDelete,
  onDeleteAnyway,
  worktreeId,
  worktreeName,
  nestedRemovalTarget,
  onNestedDeleted
}: DeleteWorktreeFailureToastOptions): void {
  const toastCopy = getDeleteWorktreeToastCopy(
    worktreeName,
    forceDeleteReason,
    error,
    lockReason ?? null
  )
  const showToast = toastCopy.isDestructive ? toast.error : toast.info
  const id = deleteWorktreeFailureToastId(worktreeId)
  const nestedTarget =
    isNestedWorktreeRemovalError(error) && window.api?.worktrees.previewNestedRemoval
      ? nestedRemovalTarget
      : undefined

  // Why: Sonner's native action/cancel slots share the title row and squeeze
  // multi-line delete errors. Custom content gives the copy its own line.
  showToast(toastCopy.title, {
    id,
    description: (
      <DeleteWorktreeFailureToastBody
        description={toastCopy.description}
        canForceDelete={canForceDelete}
        canWaiveArchiveHook={canWaiveArchiveHook === true}
        showViewChanges={!isLockedWorktreeRemovalError(error) || hasKnownChanges === true}
        onViewChanges={onViewChanges}
        onForceDelete={onForceDelete}
        onAlwaysForceDelete={onAlwaysForceDelete}
        onDeleteAnyway={onDeleteAnyway}
        toastId={id}
        nestedRemovalTarget={nestedTarget}
        worktreeName={worktreeName}
        onNestedDeleted={onNestedDeleted}
      />
    ),
    // A toast offering a destructive choice must not expire before the user reads the reason.
    duration: canForceDelete || canWaiveArchiveHook === true || nestedTarget ? Infinity : 10000,
    dismissible: true
  })
}
