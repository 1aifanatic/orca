import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import {
  nativeChatLocalAttachmentUnsupportedNotice,
  prepareNativeChatSessionAttachmentUpload,
  type NativeChatAttachmentOwner
} from './native-chat-attachment-upload'

type ClipboardImageOwner = Extract<
  NativeChatAttachmentOwner,
  { kind: 'local' | 'ssh' | 'runtime-session' }
>

/** Owners whose attachment path is a file this client can write right now. */
export function ownerAcceptsClipboardImage(
  owner: NativeChatAttachmentOwner
): owner is ClipboardImageOwner {
  return owner.kind === 'local' || owner.kind === 'ssh' || owner.kind === 'runtime-session'
}

/** Where the clipboard image is saved: this machine, the SSH host, or the chat's store on its
 *  paired server, after asking that server whether it keeps one. */
async function clipboardImageSaveArgs(
  owner: ClipboardImageOwner
): Promise<
  | { ok: true; args: Parameters<typeof window.api.ui.saveClipboardImageAsTempFile>[0] }
  | { ok: false; notice: string }
> {
  if (owner.kind === 'local') {
    return { ok: true, args: undefined }
  }
  if (owner.kind === 'ssh') {
    return { ok: true, args: { connectionId: owner.connectionId } }
  }
  const prepared = await prepareNativeChatSessionAttachmentUpload(owner)
  if (!prepared.ok) {
    return prepared
  }
  const { environmentId, ...agentSessionAttachment } = prepared.target
  return { ok: true, args: { runtimeEnvironmentId: environmentId, agentSessionAttachment } }
}

/** Save the clipboard image where the owner's agent can read it. Every failure is reported. */
export async function saveNativeChatClipboardImage(
  owner: NativeChatAttachmentOwner,
  report: { setNotice: (notice: string) => void }
): Promise<{ status: 'saved'; tempPath: string } | { status: 'empty' | 'failed' }> {
  if (!ownerAcceptsClipboardImage(owner)) {
    report.setNotice(nativeChatLocalAttachmentUnsupportedNotice())
    return { status: 'failed' }
  }
  try {
    // SSH panes save the image on the remote host (SFTP) so the attached
    // path is readable by the remote agent, matching terminal image paste.
    const target = await clipboardImageSaveArgs(owner)
    if (!target.ok) {
      report.setNotice(target.notice)
      return { status: 'failed' }
    }
    const tempPath = await window.api.ui.saveClipboardImageAsTempFile(target.args)
    return tempPath ? { status: 'saved', tempPath } : { status: 'empty' }
  } catch (error) {
    // A failed save must be visible: over SSH it fails whenever the
    // connection drops, and a silent no-op reads as a broken paste.
    report.setNotice(
      extractIpcErrorMessage(
        error,
        translate('components.native-chat.composer.imagePasteFailed', 'Image paste failed.')
      )
    )
    return { status: 'failed' }
  }
}
