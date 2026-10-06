/**
 * A real OrcaRuntimeService + real legacy `terminal.subscribe` driven by a phone at 47x40, over a
 * daemon PTY reattached after a relaunch: no host model yet, the PTY at desktop size, and a desktop
 * pane that answers its serializer at desktop size because a hidden pane never refits.
 */
import { expect, vi } from 'vitest'
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
export const PTY_ID = `${WORKTREE_ID}@@9c8d7e6f`
export const DESKTOP = { cols: 200, rows: 50 }
export const PHONE = { cols: 47, rows: 40 }
const LONG_LINE = 'A'.repeat(120)
export const EXPECTED_PHONE_ROWS = ['A'.repeat(47), 'A'.repeat(47), 'A'.repeat(26), '$ prompt']

type RuntimeInternals = {
  recordPtyWorktree: (ptyId: string, worktreeId: string, state?: { connected?: boolean }) => unknown
  issuePtyHandle: (pty: unknown) => string
  providerSnapshotPreferredPtys: Set<string>
}

export function internals(runtime: OrcaRuntimeService): RuntimeInternals {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test reaches protected members the runtime defines.
  return runtime as unknown as RuntimeInternals
}

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

export type PhoneSubscribeSetup = {
  paneMounted: boolean
  providerSnapshot?: boolean
  repaintOnResize?: boolean
  /** How a requested tab mount lands: at once, or when the test calls `finishMount`. */
  mount?: 'ready' | 'late'
}

export function setupPhoneSubscribe(opts: PhoneSubscribeSetup) {
  const sizes = new Map([[PTY_ID, { ...DESKTOP }]])
  let paneMounted = opts.paneMounted
  let settleMount: (ready: boolean) => void = () => {}
  const mountSettled = new Promise<boolean>((resolve) => {
    settleMount = resolve
  })
  const runtime = new OrcaRuntimeService()
  // The pane orders its screen against PTY output, as a mounted desktop xterm does.
  const serializeBuffer = vi.fn(async () =>
    paneMounted
      ? { data: await screenOn(DESKTOP), ...DESKTOP, seq: runtime.getPtyOutputSequence(PTY_ID) }
      : null
  )
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: (ptyId: string) => sizes.get(ptyId) ?? null,
    resize: (ptyId: string, cols: number, rows: number) => {
      sizes.set(ptyId, { cols, rows })
      if (opts.repaintOnResize) {
        // A TUI answering SIGWINCH before the subscribe reaches its own hydrate.
        runtime.onPtyData(ptyId, '\x1b[?25h', Date.now())
      }
      return true
    },
    hasRendererSerializer: () => paneMounted,
    getRendererSerializerGeneration: () => (paneMounted ? 2 : 1),
    waitForRendererSerializer: () => (opts.mount ? mountSettled : Promise.resolve(false)),
    serializeBuffer,
    // The daemon resizes its model with the PTY.
    serializeProviderBuffer: async (ptyId: string) => {
      const grid = sizes.get(ptyId) ?? DESKTOP
      return opts.providerSnapshot
        ? { data: await screenOn(grid), ...grid, seq: 0, source: 'headless' as const }
        : null
    }
  })
  const finishMount = () => {
    paneMounted = true
    settleMount(true)
  }
  const requestMount = vi
    .spyOn(runtime, 'requestRendererTerminalTabMount')
    .mockImplementation(() => {
      if (opts.mount === 'ready') {
        finishMount()
      }
      return opts.mount !== undefined
    })
  const record = internals(runtime).recordPtyWorktree(PTY_ID, WORKTREE_ID, { connected: true })
  const handle = internals(runtime).issuePtyHandle(record)
  return { runtime, handle, sizes, serializeBuffer, requestMount, finishMount }
}

export type PublishedSnapshot = {
  kind: string
  reason?: string
  cols: number
  rows: number
  data: string
}

export function subscribePhone(runtime: OrcaRuntimeService, handle: string) {
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
  /** Every complete snapshot published so far, in order. */
  const snapshots = (): PublishedSnapshot[] => {
    const published: PublishedSnapshot[] = []
    let open: PublishedSnapshot | null = null
    for (const frame of frames.flatMap((bytes) => decodeTerminalStreamFrame(bytes) ?? [])) {
      if (frame.opcode === TerminalStreamOpcode.SnapshotStart) {
        const meta = decodeTerminalStreamJson<Omit<PublishedSnapshot, 'data'>>(frame.payload)
        open = meta ? { ...meta, data: '' } : null
      } else if (frame.opcode === TerminalStreamOpcode.SnapshotChunk && open) {
        open.data += decodeTerminalStreamText(frame.payload)
      } else if (frame.opcode === TerminalStreamOpcode.SnapshotEnd && open) {
        published.push(open)
        open = null
      }
    }
    return published
  }
  const close = async () => {
    runtime.cleanupSubscription(`${handle}:phone-1`)
    controller.abort()
    await done.catch(() => {})
  }
  return { snapshots, close }
}

/** What a phone xterm sized to the frame's declared grid shows after replaying it. */
export async function paintedRows(snapshot: { cols: number; rows: number; data: string }) {
  const emulator = new HeadlessEmulator({ cols: snapshot.cols, rows: snapshot.rows, scrollback: 0 })
  try {
    await emulator.write(snapshot.data)
    return emulator.getVisibleLines().map((line) => line.trimEnd())
  } finally {
    emulator.dispose()
  }
}

export async function firstSnapshot(
  runtime: OrcaRuntimeService,
  handle: string,
  timeout = 1_000
): Promise<PublishedSnapshot> {
  const subscription = subscribePhone(runtime, handle)
  await vi.waitFor(() => expect(subscription.snapshots().length).toBeGreaterThan(0), { timeout })
  const [snapshot] = subscription.snapshots()
  await subscription.close()
  return snapshot
}
