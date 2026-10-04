import { toast } from 'sonner'
import { basename } from '@/lib/path'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { isNativeChatImageAttachmentPath } from './native-chat-image-paste'
import {
  nativeChatAttachmentHostOwner,
  nativeChatAttachmentOwnerChangedNotice,
  nativeChatAttachmentUnreadableNotice,
  prepareNativeChatSessionAttachmentUpload,
  uploadNativeChatSessionAttachmentPaths,
  type NativeChatAttachmentHostOwner,
  type NativeChatRuntimeSessionAttachmentOwner
} from './native-chat-attachment-upload'
import type { NativeChatResolvedPathOptions } from './native-chat-resolved-path-ownership'

/** The composer's pending-chip controls, as an upload drives them. */
export type NativeChatPendingAttachmentChips = {
  begin: (previewUrl?: string, pendingName?: string) => string | null
  resolve: (
    id: string,
    path: string,
    connectionId?: string | null,
    hostOwner?: NativeChatAttachmentHostOwner
  ) => void
  drop: (id: string) => void
}

/**
 * Drop or pick files into a structured chat on a paired server: upload them into the chat's store
 * there, then attach the stored paths. Each file shows as a pending chip at once, and Send waits
 * for pending chips, so a message never leaves without a file the user attached.
 */
export async function attachNativeChatSessionAttachmentPaths(args: {
  paths: string[]
  owner: NativeChatRuntimeSessionAttachmentOwner
  chips: NativeChatPendingAttachmentChips
  /** The composer was disabled or torn down meanwhile. */
  isAbandoned: () => boolean
  ownerStillCurrent: () => boolean
  attachResolvedPaths: (
    paths: string[],
    connectionId?: string | null,
    options?: NativeChatResolvedPathOptions
  ) => void
  setNotice: (notice: string | null) => void
}): Promise<void> {
  const pending = args.paths.map((path) => ({
    path,
    chipId: args.chips.begin(undefined, basename(path))
  }))
  const dropAll = (): void => {
    for (const { chipId } of pending) {
      if (chipId) {
        args.chips.drop(chipId)
      }
    }
  }
  let stored: Map<string, string> | null
  try {
    const prepared = await prepareNativeChatSessionAttachmentUpload(args.owner)
    if (!prepared.ok) {
      dropAll()
      args.setNotice(prepared.notice)
      return
    }
    stored = await uploadNativeChatSessionAttachmentPaths(args.paths, prepared.target)
  } catch (error) {
    dropAll()
    toast.error(extractIpcErrorMessage(error, 'Failed to upload files.'))
    return
  }
  if (args.isAbandoned() || !stored) {
    // A failed upload already said so in its toast.
    dropAll()
    return
  }
  if (!args.ownerStillCurrent()) {
    dropAll()
    args.setNotice(nativeChatAttachmentOwnerChangedNotice())
    return
  }
  if (stored.size === 0) {
    dropAll()
    args.setNotice(nativeChatAttachmentUnreadableNotice())
    return
  }
  const hostOwner = nativeChatAttachmentHostOwner(args.owner)
  const unchipped: string[] = []
  for (const { path, chipId } of pending) {
    const storedPath = stored.get(path)
    if (storedPath && chipId && isNativeChatImageAttachmentPath(storedPath)) {
      args.chips.resolve(chipId, storedPath, null, hostOwner)
      continue
    }
    if (chipId) {
      args.chips.drop(chipId)
    }
    if (storedPath) {
      unchipped.push(storedPath)
    }
  }
  // Other files become `@path` references, as every attach does; images without a chip get one.
  args.attachResolvedPaths(unchipped, null, { hostOwner })
}
