import { describe, expect, it, vi } from 'vitest'
import { ClaudeControlRequestError } from './claude-stream-json-connection'
import { selectStructuredAgentContextUsage } from '../../shared/structured-agent-session-context-usage'
import { assistantFrame, journal, userFrame } from './claude-context-usage-test-support'
import { sessionFor } from './claude-structured-dispatch-test-support'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'
import { setClaudeStructuredOption } from './claude-structured-options'
import { adoptClaudeStructuredSpawnOptions } from './claude-structured-spawn-options'
import type { ClaudeSession } from './claude-structured-session-state'

function ringSession(catalog: unknown[] = []) {
  const session = sessionFor()
  const setModel = vi.fn<ClaudeSession['connection']['setModel']>(async () => undefined)
  const setPermissionMode = vi.fn<ClaudeSession['connection']['setPermissionMode']>(
    async () => undefined
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: supplies every connection member a model or permission-mode write and its catalog read call.
  session.connection = {
    ...session.connection,
    setModel,
    setPermissionMode,
    supportedModels: async () => catalog
  } as ClaudeSession['connection']
  const state = journal()
  const translator = createClaudeJournalTranslator({ sink: state.sink, coalesceMs: 0 })
  const modelMayHaveChanged = vi.spyOn(translator, 'modelMayHaveChanged')
  session.translator = translator
  const write = (key: string, value: string) =>
    setClaudeStructuredOption(session, { key, value }, undefined)
  /** A turn's first response, after whatever the writes above left behind. */
  const respond = (turnId: string, at: number) => {
    translator.handle(userFrame(turnId, at))
    translator.handle(assistantFrame(`${turnId}-reply`, at + 1, 100_000))
    return selectStructuredAgentContextUsage(state.items())
  }
  return { session, setModel, modelMayHaveChanged, write, respond }
}

describe('the context ring after a session option write', () => {
  it('asks for the new window after a model or permission-mode write that changes the value', async () => {
    const s = ringSession()
    await s.write('model', 'sonnet')
    expect(s.modelMayHaveChanged).toHaveBeenCalledTimes(1)
    await s.write('model', 'sonnet[1m]')
    expect(s.modelMayHaveChanged).toHaveBeenCalledTimes(2)
    await s.write('permissionMode', 'plan')
    expect(s.modelMayHaveChanged).toHaveBeenCalledTimes(3)
    await s.write('permissionMode', 'default')
    expect(s.modelMayHaveChanged).toHaveBeenCalledTimes(4)
  })

  it('leaves the ring alone for a write that keeps the value or that the child refuses', async () => {
    const s = ringSession()
    s.session.options.set('model', 'opusplan')
    s.session.options.set('permissionMode', 'plan')
    await s.write('model', 'opusplan')
    await s.write('permissionMode', 'plan')
    s.setModel.mockRejectedValueOnce(new ClaudeControlRequestError('set_model', 'refused'))
    await expect(s.write('model', 'haiku')).rejects.toThrow()
    expect(s.modelMayHaveChanged).not.toHaveBeenCalled()
  })

  it('keeps the ring through a launch that took the saved values', () => {
    const s = ringSession()
    adoptClaudeStructuredSpawnOptions(s.session, {
      options: new Map([
        ['model', 'opusplan'],
        ['permissionMode', 'plan']
      ]),
      skipped: []
    })
    expect(s.setModel).not.toHaveBeenCalled()
    expect(s.modelMayHaveChanged).not.toHaveBeenCalled()
  })

  it('asks for the new window when the launch left the stored model out', () => {
    const s = ringSession()
    adoptClaudeStructuredSpawnOptions(s.session, { options: new Map(), skipped: ['model'] })
    expect(s.session.restoreSkippedOptions).toEqual(new Set(['model']))
    expect(s.modelMayHaveChanged).toHaveBeenCalledTimes(1)
  })

  it('sizes a new session from the model it was launched with', () => {
    const s = ringSession()
    adoptClaudeStructuredSpawnOptions(s.session, {
      options: new Map([['model', 'opus[1m]']]),
      skipped: []
    })
    expect(s.respond('turn-a', 1_000)).toMatchObject({ windowTokens: 1_000_000, percentage: 10 })
  })

  it('sizes estimates from a live model write straight away', async () => {
    const s = ringSession()
    await s.write('model', 'sonnet')
    expect(s.respond('turn-a', 1_000)).toBeNull()
    await s.write('model', 'sonnet[1m]')
    expect(s.respond('turn-b', 2_000)).toMatchObject({ windowTokens: 1_000_000, percentage: 10 })
  })

  it('implies no window for a model the child refused or the launch left out', async () => {
    const refused = ringSession()
    refused.setModel.mockRejectedValueOnce(new ClaudeControlRequestError('set_model', 'refused'))
    await expect(refused.write('model', 'opus[1m]')).rejects.toThrow()
    expect(refused.respond('turn-a', 1_000)).toBeNull()

    const skipped = ringSession()
    adoptClaudeStructuredSpawnOptions(skipped.session, { options: new Map(), skipped: ['model'] })
    expect(skipped.respond('turn-a', 1_000)).toBeNull()
  })

  it('holds estimates after a permission-mode write even with a model written before it', async () => {
    const s = ringSession()
    await s.write('model', 'sonnet[1m]')
    await s.write('permissionMode', 'plan')
    expect(s.respond('turn-a', 1_000)).toBeNull()
  })
})
