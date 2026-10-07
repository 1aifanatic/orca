import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END,
  wrapTerminalBracketedPasteText
} from '../../shared/terminal-bracketed-paste-text'
import { createAgentPromptSubmissionRuntime } from './agent-prompt-submission-runtime-test-fixture'
import { writeDesktopNewTabPrompt } from './desktop-new-tab-prompt-writer'
import { createLaunchedAgentWriteGuard } from './launched-agent-write-guard'
import { AGENT_DRAFT_PASTE_MAX_BYTES } from '../../shared/agent-draft-paste-content'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi
    .fn()
    .mockResolvedValue([
      { path: '/tmp/worktree-a', head: 'abc', branch: 'test', isBare: false, isMainWorktree: false }
    ]),
  listWorktreesStrict: vi
    .fn()
    .mockResolvedValue([
      { path: '/tmp/worktree-a', head: 'abc', branch: 'test', isBare: false, isMainWorktree: false }
    ])
}))

const draft = { inputKind: 'launch', desktopNewTab: { submit: false } } as const
const submit = { inputKind: 'launch', desktopNewTab: { submit: true } } as const

describe('desktop paste uses the existing serialized runtime writer', () => {
  afterEach(() => vi.useRealTimers())

  it('leaves a draft unsubmitted with exact launch paste bytes', async () => {
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      () => undefined,
      'claude'
    )
    const result = await runtime.sendTerminalAgentPrompt(handle, "a'🦄\nLF\r\nCRLF\rCR\x1b", draft)
    expect(writes).toEqual(["\x1b[200~a'🦄\rLF\rCRLF\rCR␛\x1b[201~"])
    expect(result).toMatchObject({ accepted: true, bytesWritten: Buffer.byteLength(writes[0]) })
    expect(result).not.toHaveProperty('prompt')
  })

  for (const agent of ['claude', 'omp'] as const) {
    it(`${agent} sends Enter in a separate write exactly 50 ms later, including Windows transport`, async () => {
      vi.useFakeTimers()
      const times: number[] = []
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
        () => times.push(Date.now()),
        agent
      )
      Object.assign(runtime, { getPtyWriteHostPlatform: () => 'win32' })
      const started = Date.now()
      const pending = runtime.sendTerminalAgentPrompt(handle, 'x'.repeat(50_000), submit)
      await vi.advanceTimersByTimeAsync(0)
      expect(writes).toEqual([wrapTerminalBracketedPasteText('x'.repeat(50_000))])
      await vi.advanceTimersByTimeAsync(49)
      expect(writes).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      await expect(pending).resolves.toMatchObject({ accepted: true })
      expect(writes[1]).toBe('\r')
      expect(times).toEqual([started, started + 50])
    })
  }

  for (const agent of ['codex', 'qwen-code'] as const) {
    it(`${agent} keeps its configured 1,200 ms best-effort Enter retry in the same transaction`, async () => {
      vi.useFakeTimers()
      const times: number[] = []
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
        () => times.push(Date.now()),
        agent
      )
      const started = Date.now()
      const pending = runtime.sendTerminalAgentPrompt(handle, 'first', submit)
      const second = runtime.sendTerminalAgentPrompt(handle, 'draft second', draft)
      await vi.runAllTimersAsync()
      await expect(pending).resolves.toMatchObject({ accepted: true })
      await second
      expect(writes).toEqual([
        wrapTerminalBracketedPasteText('first'),
        '\r',
        '\r',
        wrapTerminalBracketedPasteText('draft second')
      ])
      expect(times).toEqual([started, started + 50, started + 1250, started + 1250])
    })
  }

  it('preserves main’s known Unicode chunk-overflow bytes without interleaving another prompt', async () => {
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => undefined)
    const text = `${'a'.repeat(16_383)}🦄${'x'.repeat(70_000)}\r\n\x1b`
    await Promise.all([
      runtime.sendTerminalAgentPrompt(handle, text, draft),
      runtime.sendTerminalAgentPrompt(handle, 'second', draft)
    ])
    expect(writes[0]).toBe(BRACKETED_PASTE_START)
    expect(writes.at(-2)).toBe(BRACKETED_PASTE_END)
    expect(writes.at(-1)).toBe(wrapTerminalBracketedPasteText('second'))
    expect(writes.slice(0, -1).join('')).toBe(
      wrapTerminalBracketedPasteText(text).replace('🦄', '🦄\uDD84')
    )
    for (const data of writes.slice(1, -2)) {
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(16 * 1024)
    }
  })

  it('measures the 16 MiB desktop limit on sanitized content rather than the complete frame', async () => {
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => undefined)
    await expect(
      runtime.sendTerminalAgentPrompt(handle, 'x'.repeat(AGENT_DRAFT_PASTE_MAX_BYTES), draft)
    ).resolves.toMatchObject({ accepted: true, bytesWritten: AGENT_DRAFT_PASTE_MAX_BYTES + 12 })
    expect(writes[0]).toBe(BRACKETED_PASTE_START)
    expect(writes.at(-1)).toBe(BRACKETED_PASTE_END)
    writes.length = 0
    await expect(
      runtime.sendTerminalAgentPrompt(
        handle,
        `${'x'.repeat(AGENT_DRAFT_PASTE_MAX_BYTES - 1)}\x1b`,
        draft
      )
    ).rejects.toThrow('terminal_not_writable')
    expect(writes).toEqual([])
  })

  for (const host of ['Windows', 'plain SSH', 'known agent'] as const) {
    it(`counts each foreground guard on a chunked ${host} prompt without caching uncertain evidence`, async () => {
      vi.useFakeTimers()
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
        () => undefined,
        'claude'
      )
      const foreground = vi
        .spyOn(runtime, 'readLaunchedAgentForeground')
        .mockResolvedValue(host === 'known agent' ? 'agent' : 'unknown')
      vi.spyOn(runtime, 'launchedAgentHostProvesAgent').mockReturnValue(host !== 'Windows')
      vi.spyOn(runtime, 'launchedAgentHostReportsProcesses').mockReturnValue(host !== 'plain SSH')
      const guard = createLaunchedAgentWriteGuard(runtime, 'claude', {
        unprovableHost: 'write-unless-shell',
        processlessHostUnprovable: true
      })
      try {
        const pending = runtime.sendTerminalAgentPrompt(handle, 'x'.repeat(70_000), {
          ...submit,
          beforeWrite: guard.beforeWrite
        })
        await vi.runAllTimersAsync()
        await pending
        expect(writes).toHaveLength(8)
        expect(foreground).toHaveBeenCalledTimes(host === 'known agent' ? 1 : 8)
      } finally {
        guard.dispose()
      }
    })
  }

  it('does not close a partial paste into a replacement PTY generation', async () => {
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => undefined)
    let checks = 0
    await expect(
      runtime.sendTerminalAgentPrompt(handle, 'x'.repeat(70_000), {
        ...draft,
        beforeWrite: () => {
          if (++checks === 2) {
            runtime.synchronizePtyOutputSequenceFromProvider(
              'pty-prompt',
              { value: 0, generation: 'reset' },
              0
            )
          }
        }
      })
    ).rejects.toThrow('terminal_not_writable')
    expect(writes).toEqual([BRACKETED_PASTE_START])
  })

  it('does not write delayed Enter after close', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => undefined)
    const pending = runtime.sendTerminalAgentPrompt(handle, 'hello', submit)
    const failed = pending.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    await runtime.closeTerminal(handle)
    await vi.runAllTimersAsync()
    expect(await failed).toBeInstanceOf(Error)
    expect(writes).toEqual([wrapTerminalBracketedPasteText('hello')])
  })

  it('does not write after recorded host contact loss, without reporting process exit', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => undefined)
    const pending = runtime.sendTerminalAgentPrompt(handle, 'hello', submit)
    const exited = vi.fn()
    runtime.subscribeToPtyExit('pty-prompt', exited)
    const failed = pending.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    runtime.markPtyLivenessUnverifiable('pty-prompt', 'execution host contact lost')
    await vi.runAllTimersAsync()
    expect(await failed).toMatchObject({ message: 'terminal_not_writable' })
    expect(writes).toEqual([wrapTerminalBracketedPasteText('hello')])
    expect(runtime.getPtyLivenessVerdict('pty-prompt')).toEqual({
      status: 'unverifiable',
      reason: 'execution host contact lost'
    })
    expect(exited).not.toHaveBeenCalled()
  })

  it('rechecks cancellation after an asynchronous foreground guard', async () => {
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => undefined)
    const stop = new AbortController()
    await expect(
      runtime.sendTerminalAgentPrompt(handle, 'hello', {
        ...draft,
        signal: stop.signal,
        beforeWrite: async () => {
          await Promise.resolve()
          stop.abort()
        }
      })
    ).rejects.toThrow('request_aborted')
    expect(writes).toEqual([])
  })

  it('does not downgrade a submitted prompt when its retry is refused', async () => {
    const writes: string[] = []
    expect(
      await writeDesktopNewTabPrompt({
        text: 'hello',
        agent: 'codex',
        submit: true,
        write: async (data) => {
          writes.push(data)
          if (writes.length === 3) {
            throw new Error('agent_not_in_foreground')
          }
          return true
        },
        delay: async () => undefined
      })
    ).toEqual({ submits: 1 })
    expect(writes).toEqual([wrapTerminalBracketedPasteText('hello'), '\r', '\r'])
  })

  it('keeps generic OMP delivery joined and generic drafts outside the new writer', async () => {
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      () => undefined,
      'omp'
    )
    await runtime.sendTerminalAgentPrompt(handle, 'hello', {
      inputKind: 'launch',
      composerReady: true,
      acceptQueued: true,
      requestId: 'generic',
      observationTimeoutMs: 0
    })
    expect(writes).toEqual([`${wrapTerminalBracketedPasteText('hello')}\r`])
    await expect(
      runtime.sendTerminalAgentPrompt(handle, 'hello', {
        inputKind: 'driving',
        desktopNewTab: { submit: false }
      })
    ).rejects.toThrow('invalid_desktop_launch_prompt')
  })
})
