import { describe, expect, it } from 'vitest'
import { resolveRemoteForegroundEvidence } from './agent-foreground-process-batch'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'

function rowsFor(commands: string[], options: { tty?: string; candidateStart?: string } = {}) {
  const tty = options.tty ?? '/dev/pts/2'
  const root = 100
  const pgid = 101
  return [
    {
      pid: root,
      ppid: 1,
      pgid: root,
      tpgid: pgid,
      tty,
      startTime: 'root-start',
      stat: 'Ss',
      command: '/bin/zsh'
    },
    ...commands.map((command, index) => ({
      pid: pgid + index,
      ppid: index === 0 ? root : pgid + index - 1,
      pgid,
      tpgid: pgid,
      tty,
      startTime: options.candidateStart ?? `candidate-${index}`,
      stat: 'S+',
      command
    }))
  ] satisfies ProcessTableRow[]
}

const metadata = {
  ptyId: 'pty-1',
  ptyIncarnationId: 'inc-1',
  authorityGeneration: 'host-a',
  observationEpoch: 1,
  capturedAgeMs: 0,
  platform: 'linux' as const
}

describe('host-stamped remote foreground resolver', () => {
  it('returns live only with POSIX anchor, tty, group, and candidate start fences', () => {
    const evidence = resolveRemoteForegroundEvidence(
      { rootPid: 100, fallbackProcess: 'zsh' },
      metadata,
      rowsFor(['node /opt/codex'])
    )
    expect(evidence).toMatchObject({
      verdict: 'live',
      processName: 'codex',
      ptyId: 'pty-1',
      ptyIncarnationId: 'inc-1',
      fence: {
        platform: 'posix',
        shellPid: 100,
        shellStartTime: 'root-start',
        tty: '/dev/pts/2',
        foregroundPgid: 101,
        process: { pid: 101, startTime: 'candidate-0' }
      }
    })
  })

  it.each([
    ['multiplexer_boundary', rowsFor(['tmux new-session'])],
    ['ambiguous_foreground_group', rowsFor(['node /opt/codex', 'node /opt/claude'])],
    ['candidate_start_time_missing', rowsFor(['node /opt/codex'], { candidateStart: '' })]
  ])('degrades to unverifiable for %s', (reason, rows) => {
    const evidence = resolveRemoteForegroundEvidence(
      { rootPid: 100, fallbackProcess: 'zsh' },
      metadata,
      rows
    )
    expect(evidence).toMatchObject({ verdict: 'unverifiable', reason })
  })

  it('always degrades SSH-to-Windows without a job/console foreground primitive', () => {
    expect(
      resolveRemoteForegroundEvidence(
        { rootPid: 100, fallbackProcess: 'powershell.exe' },
        { ...metadata, platform: 'win32' },
        rowsFor(['node /opt/codex'])
      )
    ).toMatchObject({ verdict: 'unverifiable', reason: 'windows_ssh_foreground_unavailable' })
  })

  describe('shell in foreground', () => {
    const idleShell = (command: string, extra: ProcessTableRow[] = []): ProcessTableRow[] => [
      {
        pid: 100,
        ppid: 1,
        pgid: 100,
        tpgid: 100,
        tty: '/dev/pts/2',
        startTime: 'root-start',
        stat: 'Ss+',
        command
      },
      ...extra
    ]
    const resolve = (rows: ProcessTableRow[]) =>
      resolveRemoteForegroundEvidence({ rootPid: 100, fallbackProcess: 'zsh' }, metadata, rows)

    it.each(['/bin/zsh', '-zsh', 'bash --login'])('marks %s at its prompt', (command) => {
      expect(resolve(idleShell(command))).toMatchObject({
        verdict: 'live',
        processName: null,
        shellForeground: true
      })
    })

    it('does not mark a shell whose foreground group runs another program', () => {
      expect(resolve(rowsFor(['vim notes.md']))).toMatchObject({
        verdict: 'live',
        processName: null,
        shellForeground: false
      })
    })

    it('does not mark a recognized agent', () => {
      expect(resolve(rowsFor(['node /opt/claude']))).toMatchObject({
        verdict: 'live',
        processName: 'claude',
        shellForeground: false
      })
    })

    it('does not mark an agent that is itself the PTY root', () => {
      expect(resolve(idleShell('claude --resume'))).toMatchObject({
        verdict: 'live',
        shellForeground: false
      })
    })
  })
})
