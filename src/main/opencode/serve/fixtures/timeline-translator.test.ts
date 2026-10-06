import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readOpenCodeWireEvent, type OpenCodeWireEvent } from '../native-protocol'
import { OpenCodeTimelineTranslator } from '../timeline-translator'
import { object, string } from '../timeline-shapes'

function captured(name: string, major: 1 | 2): OpenCodeWireEvent[] {
  const rows = readFileSync(new URL(`./${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
  return rows.map((line) => {
    const row = object(JSON.parse(line))
    const raw = string(row?.raw)
    if (!raw?.startsWith('data: ')) {
      throw new Error('Missing captured SSE data')
    }
    return readOpenCodeWireEvent(JSON.parse(raw.slice(6)), major)
  })
}

function session(events: OpenCodeWireEvent[], major: 1 | 2): string {
  const created = events.find((event) => event.type === 'session.created')
  const id = major === 1 ? string(object(created?.data.info)?.id) : string(created?.data.sessionID)
  if (!id) {
    throw new Error('Missing captured root session')
  }
  return id
}

describe('OpenCode HTTP/SSE timeline', () => {
  it('maps 1.x snapshots, admission, tool completion, permission, and idle', () => {
    const wire = captured('v1-basic', 1)
    const translator = new OpenCodeTimelineTranslator({ sessionId: session(wire, 1), major: 1 })
    expect(translator.input('client-1', 100).map((event) => event.type)).toEqual([
      'input.accepted',
      'turn.open'
    ])
    const translated = wire.map((event) => translator.translate(event, 101))
    const events = translated.flatMap((result) => result.events)
    expect(translated.flatMap((result) => result.acceptedNativeMessageIds ?? [])).toHaveLength(1)
    expect(
      events.filter(
        (event) =>
          event.type === 'item.open' && event.body.kind === 'message' && event.body.role === 'user'
      )
    ).toHaveLength(0)
    expect(
      events.some(
        (event) =>
          event.type === 'item.close' &&
          event.body.kind === 'tool-call' &&
          event.body.state === 'completed'
      )
    ).toBe(true)
    expect(
      translated.flatMap((result) => result.requests ?? []).map((request) => request.kind)
    ).toEqual(['permission'])
    expect(
      translated
        .flatMap((result) => result.requests ?? [])[0]
        ?.body.options.map((option) => option.id)
    ).toEqual(['once', 'allow-session', 'reject'])
    expect(translated.flatMap((result) => result.withdrawnRequestIds ?? [])).toHaveLength(1)
    expect(events.some((event) => event.type === 'turn.end' && event.outcome === 'success')).toBe(
      true
    )
  })

  it('maps 2.x execution, streamed text, tool results, usage, and permission', () => {
    const wire = captured('v2-basic', 2)
    const translator = new OpenCodeTimelineTranslator({ sessionId: session(wire, 2), major: 2 })
    translator.input('client-2', 100)
    const translated = wire.map((event) => translator.translate(event, 101))
    const events = translated.flatMap((result) => result.events)
    expect(translated.flatMap((result) => result.acceptedNativeMessageIds ?? [])).toHaveLength(1)
    expect(
      events.some((event) => event.type === 'text.close' && event.text?.includes('CAPTURE-OK'))
    ).toBe(true)
    expect(
      events.some(
        (event) =>
          event.type === 'item.close' &&
          event.body.kind === 'tool-call' &&
          event.body.state === 'completed'
      )
    ).toBe(true)
    expect(
      events.some(
        (event) =>
          event.type === 'context.usage' &&
          event.usage.used?.kind === 'estimate' &&
          event.usage.used.usage.cacheReadInputTokens > 0
      )
    ).toBe(true)
    expect(events.filter((event) => event.type === 'context.usage')).toHaveLength(2)
    expect(
      translated.flatMap((result) => result.requests ?? []).map((request) => request.kind)
    ).toEqual(['permission'])
    expect(translated.at(-1)?.rootIdle).toBe(true)
  })

  it('checks child ownership and keeps child idle from ending the root turn', () => {
    for (const major of [1, 2] as const) {
      const wire = captured(major === 1 ? 'v1-child' : 'v2-child', major)
      const translator = new OpenCodeTimelineTranslator({ sessionId: session(wire, major), major })
      translator.input('root-input', 100)
      const results = wire.map((event) => translator.translate(event, 101))
      const child = results.flatMap((result) => result.children ?? [])[0]
      expect(child?.parentID).toBe(translator.options.sessionId)
      expect(translator.ownsSession(child?.id ?? '')).toBe(true)
      expect(translator.ownsSession('unrelated-session')).toBe(false)
      const childEnds = wire.flatMap((event, index) =>
        event.data.sessionID === child?.id &&
        (event.type === 'session.idle' || event.type === 'session.execution.succeeded')
          ? [results[index]]
          : []
      )
      expect(
        childEnds.every(
          (result) => !result.rootIdle && !result.events.some((event) => event.type === 'turn.end')
        )
      ).toBe(true)
    }
  })

  it('rejects unrelated sessions and salvages an unreadable execution end', () => {
    const wire = captured('v2-basic', 2)
    const root = session(wire, 2)
    const translator = new OpenCodeTimelineTranslator({ sessionId: root, major: 2 })
    translator.registerSession({ id: 'orphan', parentID: 'other-root' })
    expect(translator.ownsSession('orphan')).toBe(false)
    translator.registerSession({ id: 'child', parentID: root })
    translator.registerSession({ id: 'grandchild', parentID: 'child' })
    expect(translator.ownsSession('grandchild')).toBe(true)
    translator.input('salvage-input', 100)
    expect(
      translator.translate({ type: 'session.execution.succeeded', data: { sessionID: 'orphan' } })
        .events
    ).toEqual([])
    const result = translator.translate(
      { type: 'session.execution.terminated', data: { sessionID: root } },
      101
    )
    expect(result.events.map((event) => event.type)).toEqual(['provider.frame', 'turn.end'])
    expect(
      result.events.some(
        (event) => event.type === 'turn.end' && event.state === 'interrupted' && !event.outcome
      )
    ).toBe(true)
  })

  it('uses native question/form cards and suppresses the generic question tool', () => {
    for (const [major, name] of [
      [1, 'v1-question'],
      [2, 'v2-form']
    ] as const) {
      const wire = captured(name, major)
      const translator = new OpenCodeTimelineTranslator({ sessionId: session(wire, major), major })
      translator.input('question-input', 100)
      const translated = wire.map((event) => translator.translate(event, 101))
      const requests = translated.flatMap((result) => result.requests ?? [])
      expect(requests).toHaveLength(1)
      expect(requests[0]?.body.kind).toBe('question')
      expect(requests[0]?.body.kind === 'question' && requests[0].body.questions?.length).toBe(2)
      expect(
        requests[0]?.body.kind === 'question' && requests[0].body.questions?.[1]?.freeTextQuestionId
      ).toBe('q1')
      expect(
        translated
          .flatMap((result) => result.events)
          .some(
            (event) =>
              (event.type === 'item.open' ||
                event.type === 'item.update' ||
                event.type === 'item.close') &&
              event.body.kind === 'tool-call' &&
              event.body.name === 'question'
          )
      ).toBe(false)
    }
  })

  it('uses provider failure words and cancellation verdicts', () => {
    const v1 = captured('v1-cancel', 1)
    const cancelled = new OpenCodeTimelineTranslator({ sessionId: session(v1, 1), major: 1 })
    cancelled.input('cancel-input', 100)
    expect(
      v1
        .flatMap((event) => cancelled.translate(event, 101).events)
        .some((event) => event.type === 'turn.end' && event.outcome === 'cancellation')
    ).toBe(true)
    const v2 = captured('v2-failure', 2)
    const failed = new OpenCodeTimelineTranslator({ sessionId: session(v2, 2), major: 2 })
    failed.input('failed-input', 100)
    const events = v2.flatMap((event) => failed.translate(event, 101).events)
    expect(
      events.some(
        (event) =>
          event.type === 'item.open' &&
          event.body.kind === 'status' &&
          event.body.text.includes('Model unavailable')
      )
    ).toBe(true)
    expect(events.some((event) => event.type === 'turn.end' && event.outcome === 'failure')).toBe(
      true
    )
  })

  it('closes the captured compaction row under one native identity', () => {
    for (const major of [1, 2] as const) {
      const wire = captured(`v${major}-compact`, major)
      const sessionId = string(wire[0]?.data.sessionID)
      if (!sessionId) {
        throw new Error('Missing captured compaction session')
      }
      const translator = new OpenCodeTimelineTranslator({ sessionId, major })
      translator.input(`compact-${major}`, 100)
      const events = wire.flatMap((event) => translator.translate(event, 101).events)
      const opened = events.find(
        (event) => event.type === 'item.open' && event.body.kind === 'status'
      )
      const closed = events.find(
        (event) => event.type === 'item.close' && event.body.kind === 'status'
      )
      expect(opened?.type === 'item.open' && closed?.type === 'item.close' && opened.item).toBe(
        closed?.type === 'item.close' ? closed.item : undefined
      )
      expect(
        events.some(
          (event) => event.type === 'context.usage' && event.usage.used?.kind === 'unknown'
        )
      ).toBe(true)
    }
  })

  it('replays captured 1.x message history and 2.x event history', () => {
    for (const major of [1, 2] as const) {
      const body = JSON.parse(
        readFileSync(new URL(`./v${major}-history.json`, import.meta.url), 'utf8')
      )
      const entries = Array.isArray(body) ? body : object(body)?.data
      const first = Array.isArray(entries) ? object(entries[0]) : undefined
      const sessionId = major === 1 ? string(object(first?.info)?.sessionID) : 'history-v2'
      const translator = new OpenCodeTimelineTranslator({
        sessionId: sessionId ?? 'history-v1',
        major
      })
      const events = translator.history(body)
      expect(
        events.some(
          (event) =>
            event.type === 'item.open' &&
            event.body.kind === 'message' &&
            event.body.role === 'user'
        )
      ).toBe(true)
      expect(events.some((event) => event.type === 'text.close')).toBe(true)
      expect(events.some((event) => event.type === 'turn.end')).toBe(true)
    }
  })
})
