import { Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentPromptSubmissionRuntime } from './agent-prompt-submission-runtime-test-fixture'
import { SshPtyProvider } from '../providers/ssh-pty-provider'
import { SSH_PTY_WRITE_SETTLEMENT_TIMEOUT_MS } from '../providers/ssh-pty-write'
import { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { HEADER_LENGTH, parseJsonRpcMessage } from '../ssh/relay-protocol'
import { wrapTerminalBracketedPasteText } from '../../shared/terminal-bracketed-paste-text'

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

async function sshRuntime(stalled = false) {
  const { runtime, handle } = await createAgentPromptSubmissionRuntime(() => undefined, 'claude')
  const data: string[] = []
  let drains = 0
  const sink = new Writable({
    highWaterMark: 16 * 1024,
    write(frame: Buffer, _encoding, callback) {
      const message = parseJsonRpcMessage(frame.subarray(HEADER_LENGTH))
      if (
        'method' in message &&
        message.method === 'pty.data' &&
        typeof message.params?.data === 'string'
      ) {
        data.push(message.params.data)
      }
      if (!stalled) {
        setImmediate(callback)
      }
    }
  })
  sink.on('drain', () => {
    drains++
  })
  const mux = new SshChannelMultiplexer({
    write: (frame, onSettled) =>
      sink.write(frame, (error?: Error | null) => {
        onSettled?.(error ? { ok: false, error } : { ok: true })
      }),
    supportsWriteSettlement: true,
    onDrain: (callback) => {
      sink.on('drain', callback)
      return () => {
        sink.off('drain', callback)
      }
    },
    onData: () => {},
    onClose: () => {}
  })
  let provider = new SshPtyProvider('test', mux)
  const write = vi.fn((_id: string, text: string) => provider.write('ssh:test@@pty-prompt', text))
  const settled = vi.fn((_id: string, text: string) =>
    provider.writeWithSettlement('ssh:test@@pty-prompt', text)
  )
  runtime.setPtyController({
    write,
    writeWithSettlement: settled,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  return {
    runtime,
    handle,
    data,
    mux,
    provider,
    replaceProvider: (next: SshPtyProvider) => {
      provider = next
    },
    write,
    settled,
    drains: () => drains,
    dispose: () => {
      mux.dispose()
      sink.destroy()
    }
  }
}

describe('desktop SSH paste waits for the real asynchronous transport', () => {
  afterEach(() => vi.useRealTimers())

  it('does not write cleanup or remaining input through a replacement provider after contact loss', async () => {
    const rig = await sshRuntime(true)
    const replacement = await sshRuntime()
    try {
      const pending = rig.runtime.sendTerminalAgentPrompt(rig.handle, 'x'.repeat(70_000), {
        inputKind: 'launch',
        desktopNewTab: { submit: true }
      })
      const failed = pending.catch((error: unknown) => error)
      await vi.waitFor(() => expect(rig.data).toHaveLength(1))
      rig.mux.dispose('connection_lost')
      rig.replaceProvider(replacement.provider)
      expect(await failed).toMatchObject({ message: 'terminal_not_writable' })
      expect(rig.data).toEqual(['\x1b[200~'])
      expect(replacement.data).toEqual([])
      expect(rig.settled).toHaveBeenCalledOnce()
    } finally {
      rig.dispose()
      replacement.dispose()
    }
  })

  for (const submit of [false, true]) {
    it(`drains a 3 MiB ${submit ? 'submit' : 'draft'} without overfilling the aggregate queue`, async () => {
      const rig = await sshRuntime()
      try {
        const text = 'x'.repeat(3 * 1024 * 1024)
        let endSettledAt = 0
        let enterAt = 0
        const settled = rig.settled.getMockImplementation()
        rig.settled.mockImplementation(async (id, data) => {
          if (data === '\r') {
            enterAt = performance.now()
          }
          const result = await settled?.(id, data)
          if (data === '\x1b[201~') {
            endSettledAt = performance.now()
          }
          if (!result) {
            throw new Error('missing provider settlement')
          }
          return result
        })
        await expect(
          rig.runtime.sendTerminalAgentPrompt(rig.handle, text, {
            inputKind: 'launch',
            desktopNewTab: { submit }
          })
        ).resolves.toMatchObject({
          accepted: true,
          bytesWritten: text.length + 12 + Number(submit)
        })
        expect(rig.data.join('')).toBe(wrapTerminalBracketedPasteText(text) + (submit ? '\r' : ''))
        expect(rig.data).toHaveLength(194 + Number(submit))
        expect(rig.drains()).toBeGreaterThan(0)
        expect(rig.mux.isDisposed()).toBe(false)
        expect(rig.write).not.toHaveBeenCalled()
        if (submit) {
          expect(enterAt - endSettledAt).toBeGreaterThanOrEqual(49)
        }
      } finally {
        rig.dispose()
      }
    })
  }

  it('bounds an unsettled transport with the existing provider timeout and sends no suffix', async () => {
    vi.useFakeTimers()
    const rig = await sshRuntime(true)
    try {
      const pending = rig.runtime.sendTerminalAgentPrompt(rig.handle, 'x'.repeat(70_000), {
        inputKind: 'launch',
        desktopNewTab: { submit: true }
      })
      const failed = pending.catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(SSH_PTY_WRITE_SETTLEMENT_TIMEOUT_MS)
      expect(await failed).toMatchObject({ message: 'terminal_not_writable' })
      expect(rig.data).toEqual(['\x1b[200~'])
      expect(rig.settled).toHaveBeenCalledOnce()
      expect(rig.write).not.toHaveBeenCalled()
      expect(rig.mux.isDisposed()).toBe(true)
    } finally {
      rig.dispose()
    }
  })
})
