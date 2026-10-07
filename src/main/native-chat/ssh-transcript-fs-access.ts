import { isENOENT } from '../ipc/filesystem-path-containment'
import { requireSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { readRemoteTranscriptRange } from '../runtime/orchestration/worker-transcript-remote-range-read'
import type { SshTranscriptLocation } from './ssh-transcript-path'
import type { TranscriptFileStats } from './wsl-transcript-fs-access'

export type SshTranscriptHandle = { sshTranscript: SshTranscriptLocation }

// Why: the relay replaces Node's 'ENOENT' code with its transport code, and the readers tell a
// not-yet-written transcript (keep waiting) from a failed read by that code.
function rethrowWithNotFoundCode(error: unknown): never {
  throw error instanceof Error && isENOENT(error)
    ? Object.assign(new Error(error.message), { code: 'ENOENT' })
    : error
}

// Why: the provider is looked up per call, so a reconnect is picked up and a disconnect throws
// instead of reading anything on this machine.
export async function statSshTranscript(
  location: SshTranscriptLocation
): Promise<TranscriptFileStats> {
  const stat = await requireSshFilesystemProvider(location.connectionId)
    .stat(location.remotePath)
    .catch(rethrowWithNotFoundCode)
  const mtimeMs = stat.mtimeMs ?? stat.mtime
  return { size: stat.size, mtimeMs, ctimeMs: mtimeMs, dev: stat.dev ?? 0, ino: stat.ino ?? 0 }
}

export async function readSshTranscript(
  handle: SshTranscriptHandle,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number
): Promise<{ bytesRead: number; buffer: Buffer }> {
  const { connectionId, remotePath } = handle.sshTranscript
  const bytes = await readRemoteTranscriptRange(
    requireSshFilesystemProvider(connectionId),
    remotePath,
    position,
    length
  ).catch(rethrowWithNotFoundCode)
  buffer.set(bytes, offset)
  return { bytesRead: bytes.length, buffer }
}
