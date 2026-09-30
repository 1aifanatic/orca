import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reportAgentSessionFailure } from './agent-session-failure'
import { createLocalFileSink } from './local-file-sink'
import { setActiveSink } from './tracer'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-agent-session-failure-'))
})

afterEach(() => {
  setActiveSink(null)
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

function readTrace(filePath: string): Record<string, unknown>[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('reportAgentSessionFailure', () => {
  it('writes a failed span with its step and session to the trace file', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const filePath = join(dir, 'logs', 'main.trace.ndjson')
    const sink = createLocalFileSink({ filePath, flushBufferThreshold: 1 })
    setActiveSink(sink)

    reportAgentSessionFailure({
      step: 'lease-renewal',
      sessionId: 'session-1',
      error: new Error('dead generation work settlement failed', {
        cause: new AggregateError([new Error('journal write refused')], 'settle failed')
      }),
      detail: { fence: 3 }
    })
    sink.flush()
    sink.close()

    const records = readTrace(filePath)
    expect(records).toEqual([
      expect.objectContaining({
        type: 'effect-span',
        name: 'agent-session.failure',
        attributes: { step: 'lease-renewal', sessionId: 'session-1', fence: 3 },
        exit: { _tag: 'Failure', cause: expect.any(String) }
      })
    ])
    const { cause } = records[0].exit as { cause: string }
    // The wrapper alone names only the step; the chain is what says why.
    expect(cause).toContain('dead generation work settlement failed')
    expect(cause).toContain('[cause] AggregateError: settle failed')
    expect(cause).toContain('[aggregated] Error: journal write refused')
  })

  it('records a non-Error failure as its text', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const filePath = join(dir, 'main.trace.ndjson')
    const sink = createLocalFileSink({ filePath, flushBufferThreshold: 1 })
    setActiveSink(sink)

    reportAgentSessionFailure({ step: 'journal-rollback', error: 'database is locked' })
    sink.flush()
    sink.close()

    expect(readTrace(filePath)).toEqual([
      expect.objectContaining({
        attributes: { step: 'journal-rollback' },
        exit: { _tag: 'Failure', cause: 'database is locked' }
      })
    ])
  })

  it('keeps a recovery step to the error kind, in the trace and on the console', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const filePath = join(dir, 'main.trace.ndjson')
    const sink = createLocalFileSink({ filePath, flushBufferThreshold: 1 })
    setActiveSink(sink)
    const error = Object.assign(new Error('latest prompt: "my private words"'), { code: 'EISDIR' })

    reportAgentSessionFailure({ step: 'recovery-capsule-record', error })
    sink.flush()
    sink.close()

    expect(readTrace(filePath)).toEqual([
      expect.objectContaining({ exit: { _tag: 'Failure', cause: 'Error EISDIR' } })
    ])
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[agent-session] recovery-capsule-record failed',
      {},
      'Error EISDIR'
    )
  })

  it('still writes the console line with no trace sink installed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = new Error('boom')

    reportAgentSessionFailure({ step: 'idle-sweep', sessionId: 'session-1', error })

    expect(warn).toHaveBeenCalledWith(
      '[agent-session] idle-sweep failed',
      { sessionId: 'session-1' },
      error
    )
  })

  it('never throws, whatever the sink or the console does', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('console gone')
    })
    setActiveSink({
      push: () => {
        throw new Error('disk full')
      },
      flush: () => {},
      close: () => {}
    })

    expect(() =>
      reportAgentSessionFailure({ step: 'event-sink', sessionId: 'session-1', error: 'x' })
    ).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
