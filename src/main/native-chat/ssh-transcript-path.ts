import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { isWslHookRelayConnectionId } from '../../shared/wsl-hook-relay-contract'

// Why: the transcript engine addresses a file by one path string. A transcript on an SSH host is
// named by its connection as well, so both travel in that string and no local file can answer.
const SSH_TRANSCRIPT_PATH_PREFIX = 'orca-ssh-transcript:'

export type SshTranscriptLocation = { connectionId: string; remotePath: string }

export function toSshTranscriptPath(connectionId: string, remotePath: string): string {
  return `${SSH_TRANSCRIPT_PATH_PREFIX}${encodeURIComponent(connectionId)}:${remotePath}`
}

export function parseSshTranscriptPath(path: string): SshTranscriptLocation | null {
  if (!path.startsWith(SSH_TRANSCRIPT_PATH_PREFIX)) {
    return null
  }
  const rest = path.slice(SSH_TRANSCRIPT_PATH_PREFIX.length)
  const separator = rest.indexOf(':')
  if (separator <= 0) {
    return null
  }
  return {
    connectionId: decodeURIComponent(rest.slice(0, separator)),
    remotePath: rest.slice(separator + 1)
  }
}

/**
 * The transcript path native chat reads for a provider session. The execution host owns the
 * transcript: when the hook store attests the session to an SSH connection, the path names that
 * host, so the read goes there instead of to a same-named file on this machine.
 */
export function nativeChatTranscriptPathOnExecutionHost(
  statusRows: readonly AgentStatusIpcPayload[],
  sessionId: string,
  transcriptPath: string | undefined
): string | undefined {
  // Only the host mints this form; a client-supplied one would name a file the hook never attested.
  const requested =
    transcriptPath && !parseSshTranscriptPath(transcriptPath) ? transcriptPath : undefined
  const sshRow = statusRows.find(
    (row) =>
      row.providerSession?.id === sessionId &&
      row.providerSession.transcriptPath &&
      (requested === undefined || row.providerSession.transcriptPath === requested) &&
      row.connectionId &&
      !isWslHookRelayConnectionId(row.connectionId)
  )
  return sshRow?.connectionId && sshRow.providerSession?.transcriptPath
    ? toSshTranscriptPath(sshRow.connectionId, sshRow.providerSession.transcriptPath)
    : requested
}
