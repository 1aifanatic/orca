import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { requireSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { assertClipboardImageByteLengthWithinLimit } from '../../shared/clipboard-image'
import { authorizeExternalPath } from '../ipc/filesystem-auth'
import { nativeChatPasteFolder } from './native-chat-paste-files'

export type SaveClipboardImageAsTempFileArgs = {
  connectionId?: string | null
  runtimeEnvironmentId?: string | null
}

const REMOTE_CLIPBOARD_IMAGE_TEMP_DIR = '/tmp'

function joinRemotePath(basePath: string, fileName: string): string {
  if (isWindowsAbsolutePathLike(basePath)) {
    return path.win32.join(basePath, fileName)
  }
  return path.posix.join(basePath, fileName)
}

export async function saveClipboardImageBufferAsTempFile(
  buffer: Buffer,
  args?: SaveClipboardImageAsTempFileArgs
): Promise<string> {
  assertClipboardImageByteLengthWithinLimit(buffer.byteLength)

  const fileName = `orca-paste-${Date.now()}-${randomUUID()}.png`

  if (args?.connectionId) {
    const provider = requireSshFilesystemProvider(args.connectionId)
    const remoteTempDir = (await provider.getTempDir?.()) ?? REMOTE_CLIPBOARD_IMAGE_TEMP_DIR
    const remotePath = joinRemotePath(remoteTempDir, fileName)
    // Why: SSH terminal agents run on the remote host, so the pasted path must
    // name a remote file. The provider's base64 path writes binary bytes via SFTP.
    await provider.writeFileBase64(remotePath, buffer.toString('base64'))
    return remotePath
  }

  // Why the paste folder, not the OS temp dir: a draft that names the paste can still show and
  // send it after a restart (native-chat-paste-files).
  const folder = nativeChatPasteFolder()
  await fs.mkdir(folder, { recursive: true })
  const tempPath = path.join(folder, fileName)
  await fs.writeFile(tempPath, buffer)
  // Why: the paste folder is outside every allowed root, so without this the
  // composer's own thumbnail/preview read of the file it just wrote is denied.
  authorizeExternalPath(tempPath)
  return tempPath
}
