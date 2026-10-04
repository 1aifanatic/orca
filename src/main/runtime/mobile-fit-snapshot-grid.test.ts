/**
 * A phone-fitted subscriber must get a snapshot declared at, and laid out on, the PTY's grid.
 *
 * Harness: real OrcaRuntimeService + real legacy `terminal.subscribe`, a daemon PTY reattached
 * after a relaunch (no host model yet) whose desktop pane answers its serializer at desktop size.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { RpcDispatcher } from './rpc/dispatcher'
import type { RpcRequest } from './rpc/core'
import { TERMINAL_METHODS } from './rpc/methods/terminal'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  decodeTerminalStreamText
} from '../../shared/terminal-stream-protocol'
import { HeadlessEmulator } from '../daemon/headless-emulator'

const WORKTREE_ID = 'repo-1::/tmp/wt'
const PTY_ID = `${WORKTREE_ID}@@5e6f7a8b`
const DESKTOP = { cols: 200, rows: 50 }
const PHONE = { cols: 47, rows: 40 }
const LONG_LINE = 'A'.repeat(120)

type RuntimeInternals = {
  recordPtyWorktree: (ptyId: string, worktreeId: string, state?: { connected?: boolean }) => unknown
  issuePtyHandle: (pty: unknown) => string
}

function internals(runtime: OrcaRuntimeService): RuntimeInternals {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test reaches protected members the runtime defines.
  return runtime as unknown as RuntimeInternals
}

/** A screen serialized on `grid`, as a desktop xterm or the daemon's model would answer. */
async function screenOn(grid: { cols: number; rows: number }): Promise<string> {
  const emulator = new HeadlessEmulator({ ...grid, scrollback: 1000 })
  try {
    await emulator.write(`${LONG_LINE}\r\n$ prompt`)
    const snapshot = emulator.getSnapshot()
    return snapshot.rehydrateSequences + snapshot.snapshotAnsi
  } finally {
    emulator.dispose()
  }
}

/**
 * A daemon PTY reattached after a relaunch: no host model yet, the PTY at desktop size. The pane
 * answers its serializer at desktop size because it has not refit to the phone override yet.
 */
function setup(opts: { paneMounted: boolean; providerSnapshot: boolean }) {
  const sizes = new Map([[PTY_ID, { ...DESKTOP }]])
  let paneMounted = opts.paneMounted
  const runtime = new OrcaRuntimeService()
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: (ptyId: string) => sizes.get(ptyId) ?? null,
    resize: (ptyId: string, cols: number, rows: number) => {
      sizes.set(ptyId, { cols, rows })
      return true
    },
    hasRendererSerializer: () => paneMounted,
    getRendererSerializerGeneration: () => (paneMounted ? 2 : 1),
    waitForRendererSerializer: async () => paneMounted,
    serializeBuffer: async () =>
      paneMounted ? { data: await screenOn(DESKTOP), ...DESKTOP } : null,
    // The daemon resizes its model with the PTY; an older daemon has no authoritative snapshot.
    serializeProviderBuffer: async (ptyId: string) => {
      const grid = sizes.get(ptyId) ?? DESKTOP
      return opts.providerSnapshot
        ? { data: await screenOn(grid), ...grid, seq: 0, source: 'headless' as const }
        : null
    }
  })
  vi.spyOn(runtime, 'requestRendererTerminalTabMount').mockImplementation(() => {
    paneMounted = true
    return true
  })
  const record = internals(runtime).recordPtyWorktree(PTY_ID, WORKTREE_ID, { connected: true })
  const handle = internals(runtime).issuePtyHandle(record)
  return { runtime, handle, sizes }
}

function subscribePhone(runtime: OrcaRuntimeService, handle: string) {
  const frames: Uint8Array<ArrayBufferLike>[] = []
  const controller = new AbortController()
  const request: RpcRequest = {
    id: 'req-phone',
    authToken: 'tok',
    method: 'terminal.subscribe',
    params: {
      terminal: handle,
      client: { id: 'phone-1', type: 'mobile' },
      viewport: PHONE,
      capabilities: { terminalBinaryStream: 1 }
    }
  }
  const done = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS }).dispatchStreaming(
    request,
    () => {},
    {
      connectionId: 'conn-phone',
      signal: controller.signal,
      sendBinary: (bytes) => {
        frames.push(bytes)
      },
      registerBinaryStreamHandler: () => () => {}
    }
  )
  const decoded = () => frames.map((bytes) => decodeTerminalStreamFrame(bytes)!)
  const snapshot = () => {
    const start = decoded().find((frame) => frame.opcode === TerminalStreamOpcode.SnapshotStart)
    if (!start) {
      return null
    }
    const meta = decodeTerminalStreamJson(start.payload) as { cols: number; rows: number }
    const data = decoded()
      .filter((frame) => frame.opcode === TerminalStreamOpcode.SnapshotChunk)
      .map((frame) => decodeTerminalStreamText(frame.payload))
      .join('')
    return { cols: meta.cols, rows: meta.rows, data }
  }
  const close = async () => {
    runtime.cleanupSubscription(`${handle}:phone-1`)
    controller.abort()
    await done.catch(() => {})
  }
  return { snapshot, close }
}

/** What a phone xterm sized to the frame's declared grid shows after replaying it. */
async function paintedRows(snapshot: { cols: number; rows: number; data: string }) {
  const emulator = new HeadlessEmulator({ cols: snapshot.cols, rows: snapshot.rows, scrollback: 0 })
  try {
    await emulator.write(snapshot.data)
    return emulator.getVisibleLines().map((line) => line.trimEnd())
  } finally {
    emulator.dispose()
  }
}

const EXPECTED_PHONE_ROWS = ['A'.repeat(47), 'A'.repeat(47), 'A'.repeat(26), '$ prompt']

/** Subscribes, checks the snapshot, then resubscribes once the PTY already sits at phone size. */
async function expectPhoneGridAcrossResubscribe(runtime: OrcaRuntimeService, handle: string) {
  for (const attempt of ['first', 'resubscribe']) {
    const subscription = subscribePhone(runtime, handle)
    await vi.waitFor(() => expect(subscription.snapshot()).not.toBeNull())
    const snapshot = subscription.snapshot()!
    // Soft, so a red run shows whether the resubscribe re-reads the same stale grid.
    expect
      .soft({ attempt, cols: snapshot.cols, rows: snapshot.rows })
      .toEqual({ attempt, ...PHONE })
    expect.soft((await paintedRows(snapshot)).slice(0, 4)).toEqual(EXPECTED_PHONE_ROWS)
    await subscription.close()
  }
}

describe('phone-fitted subscribe publishes the PTY grid', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('re-lays a mounted pane screen still at desktop size when no model or provider snapshot exists', async () => {
    const { runtime, handle, sizes } = setup({ paneMounted: true, providerSnapshot: false })
    await expectPhoneGridAcrossResubscribe(runtime, handle)
    expect(sizes.get(PTY_ID)).toEqual(PHONE)
  })

  it('keeps the host model on the PTY grid when a remounted pane answers at desktop size', async () => {
    const { runtime, handle } = setup({ paneMounted: false, providerSnapshot: true })
    await expectPhoneGridAcrossResubscribe(runtime, handle)
    expect(runtime.requestRendererTerminalTabMount).toHaveBeenCalledTimes(1)
  })
})
