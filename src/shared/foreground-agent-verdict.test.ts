import { describe, expect, it } from 'vitest'
import {
  isRemoteForegroundEvidence,
  type RemoteForegroundEvidence
} from './foreground-process-evidence'
import {
  isAgentExitBlind,
  judgeForegroundAgent,
  observeHostInspection,
  type ForegroundAgentObservation
} from './foreground-agent-verdict'

const observation = {
  authorityGeneration: 'host-1',
  observationEpoch: 1,
  capturedAgeMs: 0,
  ptyId: 'pty-1',
  ptyIncarnationId: 'inc-1'
}
const fence = {
  platform: 'posix' as const,
  shellPid: 10,
  shellStartTime: '100',
  tty: '/dev/pts/1',
  foregroundPgid: 10
}
const live = (fields: { processName: string | null; shellForeground?: boolean }) =>
  ({ ...observation, verdict: 'live', fence, ...fields }) satisfies RemoteForegroundEvidence
const unverifiable = (reason: string) =>
  ({ ...observation, verdict: 'unverifiable', reason }) satisfies RemoteForegroundEvidence

describe('judgeForegroundAgent', () => {
  it.each<[string, ForegroundAgentObservation, string, boolean]>([
    ['a local agent', { kind: 'process-name', processName: 'claude' }, 'live', true],
    ['a local shell', { kind: 'process-name', processName: 'zsh' }, 'exited', true],
    ['another local program', { kind: 'process-name', processName: 'vim' }, 'unverifiable', true],
    ['an empty local read', { kind: 'process-name', processName: '' }, 'unverifiable', true],
    ['the WSL bridge', { kind: 'process-name', processName: 'wsl.exe' }, 'unverifiable', false],
    ['no answer', { kind: 'unavailable' }, 'unverifiable', true],
    ['an old host', { kind: 'host-without-evidence' }, 'unverifiable', false],
    ['an inadmissible record', { kind: 'host-evidence', evidence: null }, 'unverifiable', true],
    [
      'a host agent',
      { kind: 'host-evidence', evidence: live({ processName: 'claude', shellForeground: false }) },
      'live',
      true
    ],
    [
      'a host shell at its prompt',
      { kind: 'host-evidence', evidence: live({ processName: null, shellForeground: true }) },
      'exited',
      true
    ],
    [
      'another host program',
      { kind: 'host-evidence', evidence: live({ processName: null, shellForeground: false }) },
      'unverifiable',
      true
    ],
    [
      'an old host that cannot mark its shell',
      { kind: 'host-evidence', evidence: live({ processName: null }) },
      'unverifiable',
      false
    ],
    [
      'an SSH-to-Windows host',
      { kind: 'host-evidence', evidence: unverifiable('windows_ssh_foreground_unavailable') },
      'unverifiable',
      false
    ],
    [
      'a stale host capture',
      { kind: 'host-evidence', evidence: unverifiable('process_table_unreadable') },
      'unverifiable',
      true
    ]
  ])('judges %s', (_label, input, verdict, canCertifyExit) => {
    expect(judgeForegroundAgent(input)).toMatchObject({ verdict, canCertifyExit })
  })
})

describe('observeHostInspection', () => {
  const admit = (evidence: unknown) => (isRemoteForegroundEvidence(evidence) ? evidence : null)
  it('treats a host without an evidence field as unable to certify', () => {
    expect(
      observeHostInspection({ foregroundProcess: 'zsh', hasChildProcesses: false }, admit)
    ).toEqual({ kind: 'host-without-evidence' })
  })
  it('keeps a transport failure transient', () => {
    expect(
      observeHostInspection(
        {
          foregroundProcess: null,
          hasChildProcesses: false,
          verdict: 'unverifiable',
          reason: 'timeout'
        },
        admit
      )
    ).toEqual({ kind: 'unavailable' })
  })
})

describe('the shared blindness rule', () => {
  const processName = (name: string | null) =>
    judgeForegroundAgent({ kind: 'process-name', processName: name })
  const host = (evidence: RemoteForegroundEvidence | null) =>
    judgeForegroundAgent({ kind: 'host-evidence', evidence })
  it.each([
    [
      'a host that can never read the foreground',
      host(unverifiable('windows_ssh_foreground_unavailable')),
      true,
      true
    ],
    [
      'an old host without the shell field',
      judgeForegroundAgent({ kind: 'host-without-evidence' }),
      true,
      true
    ],
    ['tmux in front', processName('tmux'), true, true],
    ['ssh.exe in front', processName('C:\\Windows\\System32\\OpenSSH\\ssh.exe'), true, true],
    ['a remote multiplexer', host(unverifiable('multiplexer_boundary')), true, true],
    ['the WSL bridge', processName('wsl.exe'), false, true],
    ['another program', processName('vim'), false, true],
    [
      'another program on a remote host',
      host(live({ processName: null, shellForeground: false })),
      false,
      true
    ],
    ['an agent wrapper that a re-read may resolve', processName('node'), false, false],
    ['no answer', judgeForegroundAgent({ kind: 'unavailable' }), false, false],
    ['an inadmissible host record', host(null), false, false],
    ['a transient host reason', host(unverifiable('process_table_unreadable')), false, false],
    ['a live agent', processName('claude'), false, false],
    ['a shell', processName('zsh'), false, false]
  ])('%s: blind with marks %s, without marks %s', (_label, judgement, withMarks, withoutMarks) => {
    expect(isAgentExitBlind(judgement, true)).toBe(withMarks)
    expect(isAgentExitBlind(judgement, false)).toBe(withoutMarks)
  })
})
