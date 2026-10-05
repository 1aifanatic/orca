import { describe, expect, it } from 'vitest'
import { classifyAgentExitInspection } from './agent-exit-proof'
import type { TerminalProcessInspection } from '../../shared/terminal-process-inspection'

const observation = {
  authorityGeneration: 'gen',
  observationEpoch: 1,
  capturedAgeMs: 0,
  ptyId: 'pty-1',
  ptyIncarnationId: 'inc-1'
}

describe('classifyAgentExitInspection', () => {
  it('proves an exit only from a host answer with no child left under the shell', () => {
    expect(
      classifyAgentExitInspection(
        { foregroundProcess: 'zsh', hasChildProcesses: false, childProcessEvidence: 'no-children' },
        'inc-1'
      )
    ).toBe('exited')
  })

  it('treats a suspended or backgrounded child as still running', () => {
    expect(
      classifyAgentExitInspection(
        { foregroundProcess: 'zsh', hasChildProcesses: true, childProcessEvidence: 'children' },
        'inc-1'
      )
    ).toBe('running')
  })

  it.each<[string, TerminalProcessInspection | null]>([
    ['no inspection (controller missing or the read threw)', null],
    [
      'a client-only unverifiable answer (transport loss)',
      {
        foregroundProcess: null,
        hasChildProcesses: false,
        verdict: 'unverifiable',
        reason: 'transport_loss'
      }
    ],
    [
      'an old host that omits the child verdict',
      { foregroundProcess: 'zsh', hasChildProcesses: false }
    ],
    [
      'a host that could not read its process table',
      { foregroundProcess: null, hasChildProcesses: false, childProcessEvidence: 'unverifiable' }
    ],
    [
      "another incarnation's answer",
      {
        foregroundProcess: 'zsh',
        hasChildProcesses: false,
        childProcessEvidence: 'no-children',
        foregroundProcessEvidence: {
          ...observation,
          ptyIncarnationId: 'inc-0',
          verdict: 'live',
          processName: null,
          fence: {
            platform: 'posix',
            shellPid: 1,
            shellStartTime: 's',
            tty: 't',
            foregroundPgid: 1
          }
        }
      }
    ],
    [
      'an SSH-to-Windows relay that cannot fence the foreground',
      {
        foregroundProcess: null,
        hasChildProcesses: false,
        childProcessEvidence: 'no-children',
        foregroundProcessEvidence: {
          ...observation,
          verdict: 'unverifiable',
          reason: 'windows_ssh_foreground_unavailable'
        }
      }
    ]
  ])('never proves an exit from %s', (_label, inspection) => {
    expect(classifyAgentExitInspection(inspection, 'inc-1')).toBe('unverifiable')
  })
})
