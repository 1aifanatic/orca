import {
  ANTIGRAVITY_INDEX_MAX_BYTES,
  readBoundedAntigravityIndex
} from './session-scanner-antigravity-metadata'
import type { RemoteSessionFilesystemProvider } from './remote-session-scanner-types'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'

export async function readRemoteAntigravityIndex(
  provider: RemoteSessionFilesystemProvider,
  path: string,
  signal?: AbortSignal
): Promise<string | null> {
  try {
    throwIfAiVaultScanCancelled(signal)
    if (provider.readTranscriptBytes) {
      return await readBoundedAntigravityIndex(provider.readTranscriptBytes(path, signal))
    }
    const stat = await provider.stat(path)
    if (stat.size > ANTIGRAVITY_INDEX_MAX_BYTES) {
      return null
    }
    const read = await provider.readFile(path)
    throwIfAiVaultScanCancelled(signal)
    return read.isBinary || Buffer.byteLength(read.content) > ANTIGRAVITY_INDEX_MAX_BYTES
      ? null
      : read.content
  } catch (error) {
    throwIfAiVaultScanCancelled(signal)
    if (error instanceof Error && error.name === 'AbortError') {
      throw error
    }
    return null
  }
}
