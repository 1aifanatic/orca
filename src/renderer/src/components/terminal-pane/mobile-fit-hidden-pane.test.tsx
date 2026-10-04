// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { Terminal } from '@xterm/xterm'
import { SerializeAddon } from '@xterm/addon-serialize'
import { hydrateOverrides, setFitOverride } from '@/lib/pane-manager/mobile-fit-overrides'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import { safeFit } from '@/lib/pane-manager/pane-tree-ops'
import { bindRegisterPaneSerializer } from './pty-connection/pane-serializer-register'
import type { ConnectPanePtySession } from './pty-connection/connect-pane-pty-session'
import type { PtyTransport } from './pty-transport'
import { useMobileOverlayTicks } from './use-mobile-overlay-ticks'

const PTY_ID = 'daemon-pty-1'
const DESKTOP = { cols: 200, rows: 50 }
const PHONE = { cols: 47, rows: 40 }

type SerializeRequest = { requestId: string; ptyId: string; opts?: { scrollbackRows?: number } }
type SerializedReply = { data: string; cols: number; rows: number } | null

let serializeRequestHandler: ((request: SerializeRequest) => void) | null = null
const replies = new Map<string, SerializedReply>()
let pendingFrames: FrameRequestCallback[] = []

function flushFrames(): void {
  const frames = pendingFrames
  pendingFrames = []
  for (const frame of frames) {
    frame(16)
  }
}

/** A desktop pane with a real xterm and serializer; hidden means a `display: none` worktree. */
function createHiddenPane(visible = false): { pane: ManagedPane; terminal: Terminal } {
  const worktree = document.createElement('div')
  worktree.style.display = visible ? 'block' : 'none'
  const container = document.createElement('div')
  if (visible) {
    container.getBoundingClientRect = () => DOMRect.fromRect({ width: 1600, height: 900 })
  }
  worktree.appendChild(container)
  document.body.appendChild(worktree)
  const terminal = new Terminal({ ...DESKTOP, allowProposedApi: true })
  const serializeAddon = new SerializeAddon()
  terminal.loadAddon(serializeAddon)
  const pane = {
    id: 1,
    terminal,
    container,
    xtermContainer: container,
    serializeAddon,
    // The browser measures nothing inside a display:none subtree.
    fitAddon: { fit: vi.fn(), proposeDimensions: () => (visible ? DESKTOP : undefined) },
    pendingSplitScrollState: null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: pane-fit and the serializer read only the fields built above.
  return { pane: pane as unknown as ManagedPane, terminal }
}

function registerSerializer(pane: ManagedPane): void {
  const fields = {
    disposed: false,
    pane,
    rendererOrderedPtyId: null,
    rendererOrderedSeq: null,
    kittyKeyboardModes: { hasProvenBaseline: false },
    transport: { getPendingEscapeTailAnsi: () => undefined },
    onDataDisposable: { dispose: () => {} },
    clearHiddenOutputRestoreState: () => {},
    writeInputModeGround: () => {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration reads only the session fields built above.
  const session = fields as unknown as ConnectPanePtySession
  bindRegisterPaneSerializer(session)
  session.registerPaneSerializerFor(PTY_ID)
}

function writePhoneOutput(terminal: Terminal): Promise<void> {
  // What the phone-fitted PTY paints: a 60-cell line the shell wraps at the PTY width.
  return new Promise((resolve) => terminal.write(`${'A'.repeat(60)}\r\n$ `, resolve))
}

async function serializeForHost(): Promise<SerializedReply> {
  const requestId = `request-${replies.size + 1}`
  serializeRequestHandler?.({ requestId, ptyId: PTY_ID })
  await vi.waitFor(() => expect(replies.has(requestId)).toBe(true))
  return replies.get(requestId) ?? null
}

function Ticks({ pane }: { pane: ManagedPane }): null {
  useMobileOverlayTicks({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only getPanes.
    managerRef: { current: { getPanes: () => [pane] } as unknown as PaneManager },
    paneTransportsRef: {
      current: new Map<number, Pick<PtyTransport, 'getPtyId'>>([[1, { getPtyId: () => PTY_ID }]])
    }
  })
  return null
}

describe('mobile-fit override on a hidden desktop pane', () => {
  beforeEach(() => {
    replies.clear()
    pendingFrames = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((frame) => {
      pendingFrames.push(frame)
      return pendingFrames.length
    })
    vi.stubGlobal('api', {
      pty: {
        onClearBufferRequest: () => () => {},
        onResetInputModesRequest: () => () => {},
        onSerializeBufferRequest: (handler: (request: SerializeRequest) => void) => {
          serializeRequestHandler = handler
          return () => {}
        },
        sendSerializedBuffer: (requestId: string, reply: SerializedReply) => {
          replies.set(requestId, reply)
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
    hydrateOverrides([])
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('parks the pane at the phone grid when the override event lands', async () => {
    const { pane, terminal } = createHiddenPane()
    pane.container.dataset.ptyId = PTY_ID
    registerSerializer(pane)
    render(<Ticks pane={pane} />)

    act(() => setFitOverride(PTY_ID, 'mobile-fit', PHONE.cols, PHONE.rows))
    act(() => flushFrames())
    await writePhoneOutput(terminal)

    const reply = await serializeForHost()
    expect({ cols: reply?.cols, rows: reply?.rows }).toEqual(PHONE)
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('A'.repeat(47))
    terminal.dispose()
  })

  it('answers a serialize request that lands before the fit frame at the override grid', async () => {
    const { pane, terminal } = createHiddenPane(true)
    pane.container.dataset.ptyId = PTY_ID
    registerSerializer(pane)
    render(<Ticks pane={pane} />)

    // The host sends the override, then its serialize request, on one ordered channel.
    act(() => setFitOverride(PTY_ID, 'mobile-fit', PHONE.cols, PHONE.rows))
    expect(pendingFrames).toHaveLength(1)
    const reply = await serializeForHost()

    expect(pendingFrames).toHaveLength(1)
    expect({ cols: reply?.cols, rows: reply?.rows }).toEqual(PHONE)
    act(() => flushFrames())
    expect({ cols: terminal.cols, rows: terminal.rows }).toEqual(PHONE)
    terminal.dispose()
  })

  it('parks a pane that binds its PTY after the override already exists', async () => {
    setFitOverride(PTY_ID, 'mobile-fit', PHONE.cols, PHONE.rows)
    const { pane, terminal } = createHiddenPane()
    registerSerializer(pane)

    // terminal-keydown-fit.ts setPanePtyFitBinding: bind, then safeFit under an override.
    pane.container.dataset.ptyId = PTY_ID
    safeFit(pane)
    await writePhoneOutput(terminal)

    const reply = await serializeForHost()
    expect({ cols: reply?.cols, rows: reply?.rows }).toEqual(PHONE)
    terminal.dispose()
  })
})
