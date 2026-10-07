import { useCallback, useLayoutEffect, useRef, type DragEventHandler } from 'react'
import { useAppStore } from '@/store'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  getWorkspaceFileDragRejectionMessage,
  hasWorkspaceFileDragType,
  isResolvedWorkspaceFileDragExecutionHost,
  readWorkspaceFileDragPaths,
  readWorkspaceFileDragSource
} from '@/lib/workspace-file-drag'
import {
  resolveNativeChatAttachmentOwner,
  nativeChatWorktreeNotReadyNotice
} from './native-chat-attachment-upload'
import {
  isNativeChatTabScopeCurrent,
  sameNativeChatTabScope,
  type NativeChatTabScope
} from './native-chat-tab-scope'
import {
  nativeChatAttachmentOwnerUnchanged,
  nativeChatWorkspaceAttachmentMismatchNotice,
  type NativeChatResolvedPathOptions
} from './native-chat-resolved-path-ownership'
import { useNativeChatPaneFileDropClaim } from './NativeChatPaneFileDropSurface'

type WorkspaceFileDropHandlers = {
  onDragOverCapture: DragEventHandler<HTMLDivElement>
  onDropCapture: DragEventHandler<HTMLDivElement>
}

type Args = {
  attachResolvedPaths: (
    paths: string[],
    connectionId?: string | null,
    options?: NativeChatResolvedPathOptions
  ) => void
  disabled: boolean
  /** Composer identity the preload drop route addresses; published to the pane
   *  so an OS drop anywhere in it resolves to this composer. */
  paneKey: string
  setNotice: (notice: string | null) => void
  scope: NativeChatTabScope
}

// The composer sits inside the terminal surface, which accepts the same drag and
// pastes it into the shell. Claiming the event here is what keeps a drop aimed at
// the composer out of the terminal behind it — including when we refuse it.
function claimWorkspaceFileDrag(event: React.DragEvent<HTMLDivElement>): void {
  event.preventDefault()
  event.stopPropagation()
}

function setDropEffect(dataTransfer: DataTransfer, effect: 'copy' | 'none'): void {
  if (effect === 'none') {
    dataTransfer.dropEffect = 'none'
    return
  }
  if (
    dataTransfer.effectAllowed === 'all' ||
    dataTransfer.effectAllowed === 'copy' ||
    dataTransfer.effectAllowed === 'copyLink' ||
    dataTransfer.effectAllowed === 'copyMove' ||
    dataTransfer.effectAllowed === 'uninitialized'
  ) {
    dataTransfer.dropEffect = 'copy'
  }
}

export function useNativeChatWorkspaceFileDrop({
  attachResolvedPaths,
  disabled,
  paneKey,
  setNotice,
  scope
}: Args): WorkspaceFileDropHandlers {
  // The IME-flush check runs against a closure captured at drop time. Reading
  // the prop through a ref keeps "is this still my workspace?" a real question
  // rather than a comparison of one captured value against itself.
  const scopeRef = useRef(scope)
  useLayoutEffect(() => {
    scopeRef.current = scope
  }, [scope])

  const onDragOverCapture = useCallback<DragEventHandler<HTMLDivElement>>(
    (event) => {
      if (!hasWorkspaceFileDragType(event.dataTransfer)) {
        return
      }
      claimWorkspaceFileDrag(event)
      // A guarded composer answers `none` rather than promising a copy it will
      // then drop on the floor: the cursor refuses, and no drop event follows.
      setDropEffect(event.dataTransfer, disabled ? 'none' : 'copy')
    },
    [disabled]
  )

  const onDropCapture = useCallback<DragEventHandler<HTMLDivElement>>(
    (event) => {
      if (!hasWorkspaceFileDragType(event.dataTransfer)) {
        return
      }
      claimWorkspaceFileDrag(event)
      if (disabled) {
        setDropEffect(event.dataTransfer, 'none')
        return
      }
      setDropEffect(event.dataTransfer, 'copy')

      const dragPaths = readWorkspaceFileDragPaths(event.dataTransfer)
      if (dragPaths.status === 'rejected') {
        setNotice(getWorkspaceFileDragRejectionMessage(dragPaths.reason))
        return
      }
      if (dragPaths.paths.length === 0) {
        return
      }

      const state = useAppStore.getState()
      const workspaceId = scope.worktreeId
      const source = readWorkspaceFileDragSource(event.dataTransfer)
      if (
        !isNativeChatTabScopeCurrent(state, scope) ||
        !source ||
        source.workspaceId !== workspaceId
      ) {
        setNotice(nativeChatWorkspaceAttachmentMismatchNotice())
        return
      }
      const owner = resolveNativeChatAttachmentOwner(state, scope)
      if (owner.kind === 'not-ready') {
        setNotice(nativeChatWorktreeNotReadyNotice())
        return
      }
      const targetExecutionHostId = getExecutionHostIdForWorktree(state, workspaceId)
      if (
        !isResolvedWorkspaceFileDragExecutionHost(targetExecutionHostId) ||
        source.executionHostId !== targetExecutionHostId
      ) {
        setNotice(nativeChatWorkspaceAttachmentMismatchNotice())
        return
      }

      // Why the captured scope: a moved tab is refused, never followed to its new workspace.
      const capturedScope = scope
      const targetOwnerIsCurrent = (): boolean => {
        if (!sameNativeChatTabScope(capturedScope, scopeRef.current)) {
          return false
        }
        // Store first: membership can change before the parent rerenders with new props.
        const currentState = useAppStore.getState()
        const currentHostId = getExecutionHostIdForWorktree(currentState, workspaceId)
        const currentOwner = resolveNativeChatAttachmentOwner(currentState, capturedScope)
        return (
          isResolvedWorkspaceFileDragExecutionHost(currentHostId) &&
          currentHostId === source.executionHostId &&
          nativeChatAttachmentOwnerUnchanged(owner, currentOwner)
        )
      }

      attachResolvedPaths(dragPaths.paths, owner.kind === 'ssh' ? owner.connectionId : undefined, {
        targetOwnerIsCurrent
      })
    },
    [attachResolvedPaths, disabled, scope, setNotice]
  )

  // The pane around the composer is the drop surface; these handlers run from
  // there so the whole chat, not just the input box, accepts a file.
  useNativeChatPaneFileDropClaim({
    scopeKey: paneKey,
    disabled,
    onDragOverCapture,
    onDropCapture
  })

  return { onDragOverCapture, onDropCapture }
}
