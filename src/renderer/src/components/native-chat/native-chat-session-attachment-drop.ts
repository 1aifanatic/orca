import { basename } from '@/lib/path'
import { isNativeChatImageAttachmentPath } from './native-chat-image-paste'
import {
  nativeChatAttachFailedNotice,
  nativeChatAttachmentOwnerChangedNotice,
  prepareNativeChatSessionAttachmentUpload,
  uploadNativeChatSessionAttachmentPaths,
  type NativeChatRuntimeSessionAttachmentOwner
} from './native-chat-attachment-upload'
import type { NativeChatResolvedPathOptions } from './native-chat-resolved-path-ownership'

/** The composer's pending-chip controls, as an upload drives them. */
export type NativeChatPendingAttachmentChips = {
  begin: (previewUrl?: string, pendingName?: string) => string | null
  resolve: (id: string, path: string, connectionId?: string | null) => void
  /** Removes the chip; false when the user already removed it, so its file must not attach. */
  drop: (id: string) => boolean
}

/**
 * Drop or pick files into a structured chat on a paired server: upload them into the chat's store
 * there, then attach the stored paths. Each file shows as a pending chip with its name at once, and
 * Send waits for pending chips, so a message never leaves without a file the user attached. A chip
 * the user removes meanwhile attaches nothing.
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
  const pending = args.paths.flatMap((path) => {
    const chipId = args.chips.begin(undefined, basename(path))
    // No chip: the composer refused the attach and already said why.
    return chipId ? [{ path, chipId }] : []
  })
  if (pending.length === 0) {
    return
  }
  const dropAll = (): void => {
    for (const { chipId } of pending) {
      args.chips.drop(chipId)
    }
  }
  const failAll = (): void => {
    dropAll()
    args.setNotice(nativeChatAttachFailedNotice(pending.map(({ path }) => basename(path))))
  }
  let stored: Map<string, string>
  try {
    const prepared = await prepareNativeChatSessionAttachmentUpload(args.owner)
    if (!prepared.ok) {
      dropAll()
      args.setNotice(prepared.notice)
      return
    }
    const result = await uploadNativeChatSessionAttachmentPaths(
      pending.map(({ path }) => path),
      prepared.target
    )
    stored = new Map(result.uploaded.map(({ sourcePath, path }) => [sourcePath, path]))
  } catch {
    if (!args.isAbandoned()) {
      failAll()
    }
    return
  }
  if (args.isAbandoned()) {
    dropAll()
    return
  }
  if (!args.ownerStillCurrent()) {
    dropAll()
    args.setNotice(nativeChatAttachmentOwnerChangedNotice())
    return
  }
  const notAttached: string[] = []
  const references: string[] = []
  for (const { path, chipId } of pending) {
    const storedPath = stored.get(path)
    if (!storedPath) {
      if (args.chips.drop(chipId)) {
        notAttached.push(basename(path))
      }
      continue
    }
    if (isNativeChatImageAttachmentPath(storedPath)) {
      args.chips.resolve(chipId, storedPath, null)
      continue
    }
    // Other files become `@path` references, as every attach does, unless their chip was removed.
    if (args.chips.drop(chipId)) {
      references.push(storedPath)
    }
  }
  // Attaching clears the notice, so what failed is said after.
  args.attachResolvedPaths(references, null)
  if (notAttached.length > 0) {
    args.setNotice(nativeChatAttachFailedNotice(notAttached))
  }
}
