import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_ERROR_STEPS,
  traceAgentSessionError,
  type AgentSessionErrorStep
} from './agent-session-error-trace'
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

describe('traceAgentSessionError', () => {
  it('writes a failed span with its step and session to the trace file', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const filePath = join(dir, 'logs', 'main.trace.ndjson')
    const sink = createLocalFileSink({ filePath, flushBufferThreshold: 1 })
    setActiveSink(sink)

    traceAgentSessionError({
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

    traceAgentSessionError({ step: 'journal-rollback', error: 'database is locked' })
    sink.flush()
    sink.close()

    expect(readTrace(filePath)).toEqual([
      expect.objectContaining({
        attributes: { step: 'journal-rollback' },
        exit: { _tag: 'Failure', cause: 'database is locked' }
      })
    ])
  })

  it('keeps a SQLite or journal code the message leaves out', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const filePath = join(dir, 'main.trace.ndjson')
    const sink = createLocalFileSink({ filePath, flushBufferThreshold: 1 })
    setActiveSink(sink)
    const error = Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' })

    traceAgentSessionError({ step: 'journal-rollback', error })
    sink.flush()
    sink.close()

    const { cause } = readTrace(filePath)[0].exit as { cause: string }
    expect(cause).toContain('database or disk is full')
    expect(cause).toContain('[code] SQLITE_FULL')
  })

  it('keeps its own step and session over same-named detail keys', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const filePath = join(dir, 'main.trace.ndjson')
    const sink = createLocalFileSink({ filePath, flushBufferThreshold: 1 })
    setActiveSink(sink)

    traceAgentSessionError({
      step: 'idle-sweep',
      sessionId: 'session-1',
      error: 'x',
      detail: { step: 'forged', sessionId: 'session-2', fence: 3 }
    })
    sink.flush()
    sink.close()

    expect(readTrace(filePath)[0].attributes).toEqual({
      step: 'idle-sweep',
      sessionId: 'session-1',
      fence: 3
    })
    expect(warn).toHaveBeenCalledWith(
      '[agent-session] idle-sweep failed',
      { sessionId: 'session-1', fence: 3, step: 'forged' },
      'x'
    )
  })

  // Reclassifying a step edits this list, next to the reason in the step table.
  const kindOnlySteps: readonly AgentSessionErrorStep[] = [
    'operation-uncertainty-persist',
    'refused-operation-settlement',
    'recovery-capsule-read',
    'recovery-capsule-record',
    'recovery-witness-begin',
    'recovery-witness-capture',
    'recovery-records-forget',
    'restart-offer-prune',
    'restart-offer-withdraw',
    'restart-offer-complete',
    'restart-offer-rollback',
    'restart-offer-refresh',
    'restart-failure-record',
    'restart-continuation-send',
    'restart-continuation-note'
  ]

  it('keeps exactly the pinned steps to the error kind', () => {
    const tableKindSteps = Object.entries(AGENT_SESSION_ERROR_STEPS)
      .filter(([, recorded]) => recorded === 'kind')
      .map(([step]) => step)
    expect(tableKindSteps.sort()).toEqual([...kindOnlySteps].sort())
  })

  it.each(kindOnlySteps)('keeps %s to the error kind, in the trace and on the console', (step) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const filePath = join(dir, 'main.trace.ndjson')
    const sink = createLocalFileSink({ filePath, flushBufferThreshold: 1 })
    setActiveSink(sink)
    // What a corrupt capsule's parse throws: V8 quotes the input's first 10 characters.
    const quoting = syntaxErrorQuoting('my private words')
    expect(String(quoting)).toContain('my private')
    const error = new Error('outer', { cause: quoting })

    traceAgentSessionError({ step, sessionId: 'session-1', error })
    sink.flush()
    sink.close()

    expect(readFileSync(filePath, 'utf8')).not.toContain('my private')
    expect(readTrace(filePath)).toEqual([
      expect.objectContaining({ exit: { _tag: 'Failure', cause: 'Error' } })
    ])
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      `[agent-session] ${step} failed`,
      { sessionId: 'session-1' },
      'Error'
    )
  })

  it('keeps a recovery step to the error kind, in the trace and on the console', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const filePath = join(dir, 'main.trace.ndjson')
    const sink = createLocalFileSink({ filePath, flushBufferThreshold: 1 })
    setActiveSink(sink)
    const error = Object.assign(new Error('latest prompt: "my private words"'), { code: 'EISDIR' })

    traceAgentSessionError({ step: 'recovery-capsule-record', error })
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

    traceAgentSessionError({ step: 'idle-sweep', sessionId: 'session-1', error })

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
      traceAgentSessionError({ step: 'event-sink', sessionId: 'session-1', error: 'x' })
    ).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

function syntaxErrorQuoting(text: string): unknown {
  try {
    JSON.parse(text)
  } catch (error) {
    return error
  }
  throw new Error('expected a SyntaxError')
}
