import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { wslHookRelayConnectionId } from '../../shared/wsl-hook-relay-contract'
import {
  nativeChatTranscriptPathOnExecutionHost,
  parseSshTranscriptPath,
  toSshTranscriptPath
} from './ssh-transcript-path'

const REMOTE_PATH = '/home/ada/.claude/projects/p/session-1.jsonl'

function row(connectionId: string | null, transcriptPath = REMOTE_PATH): AgentStatusIpcPayload {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lookup reads only these fields.
  return {
    connectionId,
    providerSession: { key: 'session_id', id: 'session-1', transcriptPath }
  } as AgentStatusIpcPayload
}

describe('nativeChatTranscriptPathOnExecutionHost', () => {
  it('names the SSH host the hook store attests the session to', () => {
    const path = nativeChatTranscriptPathOnExecutionHost(
      [row('target:1')],
      'session-1',
      REMOTE_PATH
    )

    expect(path && parseSshTranscriptPath(path)).toEqual({
      connectionId: 'target:1',
      remotePath: REMOTE_PATH
    })
  })

  it('leaves local and WSL sessions on this machine', () => {
    const wsl = wslHookRelayConnectionId('Ubuntu')

    expect(nativeChatTranscriptPathOnExecutionHost([row(null)], 'session-1', REMOTE_PATH)).toBe(
      REMOTE_PATH
    )
    expect(nativeChatTranscriptPathOnExecutionHost([row(wsl)], 'session-1', REMOTE_PATH)).toBe(
      REMOTE_PATH
    )
  })

  it('does not adopt an SSH row whose transcript differs from the one asked for', () => {
    expect(
      nativeChatTranscriptPathOnExecutionHost([row('target-1')], 'session-1', '/tmp/other.jsonl')
    ).toBe('/tmp/other.jsonl')
  })

  it('ignores an SSH-qualified path a client sends itself', () => {
    const forged = toSshTranscriptPath('target-1', '/etc/secret.jsonl')

    expect(nativeChatTranscriptPathOnExecutionHost([], 'session-1', forged)).toBeUndefined()
  })
})
