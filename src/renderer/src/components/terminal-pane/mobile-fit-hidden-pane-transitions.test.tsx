// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { Terminal } from '@xterm/xterm'
import {
  getFitOverrideForPty,
  hydrateOverrides,
  replaceFitOverridePtyId,
  setFitOverride
} from '@/lib/pane-manager/mobile-fit-overrides'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import { safeFit } from '@/lib/pane-manager/pane-tree-ops'
import { fitRevealedPane } from '@/lib/pane-manager/pane-reveal-fit'
import {
  beginTerminalScrollIntentBufferRebuild,
  endTerminalScrollIntentBufferRebuild
} from '@/lib/pane-manager/terminal-scroll-intent-rebuild'
import type { PtyTransport } from './pty-transport'
import { useMobileOverlayTicks } from './use-mobile-overlay-ticks'
import { createHiddenPane, DESKTOP, PHONE } from './mobile-fit-hidden-pane-fixture'

const PTY_A = 'daemon-pty-a'
const PTY_B = 'daemon-pty-b'
const ROTATED = { cols: 90, rows: 30 }

let panes: ManagedPane[] = []
let pendingFrames: FrameRequestCallback[] = []
// The tab's live transport bindings, which resolve each pane's PTY for the hook.
let transports = new Map<number, Pick<PtyTransport, 'getPtyId'>>()

function Ticks(): null {
  useMobileOverlayTicks({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only getPanes.
    managerRef: { current: { getPanes: () => panes } as unknown as PaneManager },
    paneTransportsRef: {
      get current() {
        return transports
      }
    }
  })
  return null
}

/** terminal-keydown-fit.ts setPanePtyFitBinding: the transport owns the PTY, then the DOM marker follows and an override parks. */
function bindPane(pane: ManagedPane, ptyId: string): void {
  transports.set(pane.id, { getPtyId: () => ptyId })
  pane.container.dataset.ptyId = ptyId
  if (getFitOverrideForPty(ptyId)) {
    safeFit(pane)
  }
}

function mountPane(ptyId: string, visible = false, id = 1) {
  const created = createHiddenPane(visible, id)
  panes.push(created.pane)
  bindPane(created.pane, ptyId)
  return created
}

function flushFrames(): void {
  for (let frame = 0; frame < 5; frame++) {
    const frames = pendingFrames
    pendingFrames = []
    act(() => frames.forEach((callback) => callback(16)))
  }
}

function grid(terminal: Terminal): { cols: number; rows: number } {
  return { cols: terminal.cols, rows: terminal.rows }
}

describe('hidden desktop pane across mobile-fit transitions', () => {
  beforeEach(() => {
    panes = []
    transports = new Map()
    pendingFrames = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((frame) => {
      pendingFrames.push(frame)
      return pendingFrames.length
    })
  })

  afterEach(() => {
    cleanup()
    hydrateOverrides([])
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('leaves a pane rebound to another PTY alone on the old release, then follows its own PTY', () => {
    const { pane, terminal } = mountPane(PTY_A)
    render(<Ticks />)
    act(() => setFitOverride(PTY_A, 'mobile-fit', PHONE.cols, PHONE.rows))
    expect(grid(terminal)).toEqual(PHONE)

    // A fresh PTY in a hidden pane spawns at the xterm grid, so the parked grid is its size.
    act(() => bindPane(pane, PTY_B))
    act(() => setFitOverride(PTY_A, 'desktop-fit', DESKTOP.cols, DESKTOP.rows))
    expect(grid(terminal)).toEqual(PHONE)

    act(() => setFitOverride(PTY_B, 'mobile-fit', ROTATED.cols, ROTATED.rows))
    expect(grid(terminal)).toEqual(ROTATED)
    act(() => setFitOverride(PTY_B, 'desktop-fit', DESKTOP.cols, DESKTOP.rows))
    expect(grid(terminal)).toEqual(DESKTOP)
    terminal.dispose()
  })

  it('parks a pane rebound onto a PTY whose override already exists', () => {
    const { pane, terminal } = mountPane(PTY_A)
    render(<Ticks />)
    act(() => setFitOverride(PTY_A, 'mobile-fit', PHONE.cols, PHONE.rows))
    // The event for an unmounted PTY reaches no pane in this tab.
    act(() => setFitOverride(PTY_B, 'mobile-fit', ROTATED.cols, ROTATED.rows))
    expect(grid(terminal)).toEqual(PHONE)

    act(() => bindPane(pane, PTY_B))
    expect(grid(terminal)).toEqual(ROTATED)
    terminal.dispose()
  })

  it('re-parks synchronously when the phone grid changes while hidden', () => {
    const { terminal } = mountPane(PTY_A)
    render(<Ticks />)
    act(() => setFitOverride(PTY_A, 'mobile-fit', PHONE.cols, PHONE.rows))
    act(() => setFitOverride(PTY_A, 'mobile-fit', ROTATED.cols, ROTATED.rows))
    expect(grid(terminal)).toEqual(ROTATED)
    act(() => setFitOverride(PTY_A, 'desktop-fit', DESKTOP.cols, DESKTOP.rows))
    expect(grid(terminal)).toEqual(DESKTOP)
    terminal.dispose()
  })

  it('parks and un-parks both hidden split panes bound to one PTY', () => {
    const left = mountPane(PTY_A, false, 1)
    const right = mountPane(PTY_A, false, 2)
    render(<Ticks />)
    act(() => setFitOverride(PTY_A, 'mobile-fit', PHONE.cols, PHONE.rows))
    expect([grid(left.terminal), grid(right.terminal)]).toEqual([PHONE, PHONE])
    act(() => setFitOverride(PTY_A, 'desktop-fit', DESKTOP.cols, DESKTOP.rows))
    expect([grid(left.terminal), grid(right.terminal)]).toEqual([DESKTOP, DESKTOP])
    left.terminal.dispose()
    right.terminal.dispose()
  })

  it('un-parks a pane parked while visible that was hidden before the release', () => {
    const { terminal, setVisible } = mountPane(PTY_A, true)
    render(<Ticks />)
    act(() => setFitOverride(PTY_A, 'mobile-fit', PHONE.cols, PHONE.rows))
    expect(grid(terminal)).toEqual(PHONE)

    setVisible(false)
    act(() => setFitOverride(PTY_A, 'desktop-fit', DESKTOP.cols, DESKTOP.rows))
    expect(grid(terminal)).toEqual(DESKTOP)
    terminal.dispose()
  })

  it('parks and un-parks a hidden pane for a remote desktop owner', () => {
    const { terminal } = mountPane(PTY_A)
    render(<Ticks />)
    act(() => setFitOverride(PTY_A, 'remote-desktop-fit', ROTATED.cols, ROTATED.rows))
    expect(grid(terminal)).toEqual(ROTATED)
    act(() => setFitOverride(PTY_A, 'desktop-fit', DESKTOP.cols, DESKTOP.rows))
    expect(grid(terminal)).toEqual(DESKTOP)
    terminal.dispose()
  })

  it('switches a hidden pane straight from a phone owner to a remote desktop owner', () => {
    const { terminal } = mountPane(PTY_A)
    render(<Ticks />)
    act(() => setFitOverride(PTY_A, 'mobile-fit', PHONE.cols, PHONE.rows))
    act(() => setFitOverride(PTY_A, 'remote-desktop-fit', ROTATED.cols, ROTATED.rows))
    expect(grid(terminal)).toEqual(ROTATED)
    terminal.dispose()
  })

  it('parks a hidden pane when override hydration lands after mount', () => {
    const { terminal } = mountPane(PTY_A)
    render(<Ticks />)
    act(() => hydrateOverrides([{ ptyId: PTY_A, mode: 'mobile-fit', ...PHONE }]))
    expect(grid(terminal)).toEqual(PHONE)
    terminal.dispose()
  })

  it('keeps a hidden pane parked across a remote handle rotation, then follows the new handle release', () => {
    const { pane, terminal } = mountPane(PTY_A)
    render(<Ticks />)
    act(() => setFitOverride(PTY_A, 'mobile-fit', PHONE.cols, PHONE.rows))

    // remote-runtime-pty-transport: the transport adopts the new handle, carries the hold, then rebinds the pane.
    act(() => {
      transports.set(pane.id, { getPtyId: () => PTY_B })
      replaceFitOverridePtyId(PTY_A, PTY_B)
      bindPane(pane, PTY_B)
    })
    expect(grid(terminal)).toEqual(PHONE)
    act(() => setFitOverride(PTY_B, 'desktop-fit', DESKTOP.cols, DESKTOP.rows))
    expect(grid(terminal)).toEqual(DESKTOP)
    terminal.dispose()
  })

  it('parks at the new handle grid when it already published its own override', () => {
    const { pane, terminal } = mountPane(PTY_A)
    render(<Ticks />)
    act(() => setFitOverride(PTY_A, 'mobile-fit', PHONE.cols, PHONE.rows))
    act(() => setFitOverride(PTY_B, 'mobile-fit', ROTATED.cols, ROTATED.rows))

    act(() => {
      transports.set(pane.id, { getPtyId: () => PTY_B })
      replaceFitOverridePtyId(PTY_A, PTY_B)
      bindPane(pane, PTY_B)
    })
    expect(grid(terminal)).toEqual(ROTATED)
    terminal.dispose()
  })

  it('un-parks a hidden pane once a rebuild that deferred the release ends', async () => {
    const { terminal } = mountPane(PTY_A)
    render(<Ticks />)
    act(() => setFitOverride(PTY_A, 'mobile-fit', PHONE.cols, PHONE.rows))

    beginTerminalScrollIntentBufferRebuild(terminal)
    act(() => setFitOverride(PTY_A, 'desktop-fit', DESKTOP.cols, DESKTOP.rows))
    expect(grid(terminal)).toEqual(PHONE)
    endTerminalScrollIntentBufferRebuild(terminal)
    await Promise.resolve()

    expect(grid(terminal)).toEqual(DESKTOP)
    terminal.dispose()
  })

  it('drops a deferred release fallback for a pane rebound to another PTY before the rebuild ends', async () => {
    const { pane, terminal } = mountPane(PTY_A)
    render(<Ticks />)
    act(() => setFitOverride(PTY_A, 'mobile-fit', PHONE.cols, PHONE.rows))

    beginTerminalScrollIntentBufferRebuild(terminal)
    act(() => setFitOverride(PTY_A, 'desktop-fit', DESKTOP.cols, DESKTOP.rows))
    act(() => bindPane(pane, PTY_B))
    endTerminalScrollIntentBufferRebuild(terminal)
    await Promise.resolve()

    expect(grid(terminal)).toEqual(PHONE)
    terminal.dispose()
  })

  it('drops a deferred release fallback for a pane closed before the rebuild ends', async () => {
    const { pane, terminal } = mountPane(PTY_A)
    render(<Ticks />)
    act(() => setFitOverride(PTY_A, 'mobile-fit', PHONE.cols, PHONE.rows))

    beginTerminalScrollIntentBufferRebuild(terminal)
    act(() => setFitOverride(PTY_A, 'desktop-fit', DESKTOP.cols, DESKTOP.rows))
    panes = panes.filter((candidate) => candidate !== pane)
    transports.delete(pane.id)
    endTerminalScrollIntentBufferRebuild(terminal)
    await Promise.resolve()

    expect(grid(terminal)).toEqual(PHONE)
    terminal.dispose()
  })

  it('leaves a hidden desktop-grid pane alone on a release with no prior hold', () => {
    const { terminal } = mountPane(PTY_A)
    terminal.resize(160, 45)
    render(<Ticks />)
    act(() => setFitOverride(PTY_A, 'desktop-fit', DESKTOP.cols, DESKTOP.rows))
    expect(grid(terminal)).toEqual({ cols: 160, rows: 45 })
    terminal.dispose()
  })

  it('stays at the override grid when a parked hidden pane is revealed', () => {
    const { pane, terminal, setVisible } = mountPane(PTY_A)
    render(<Ticks />)
    act(() => setFitOverride(PTY_A, 'mobile-fit', PHONE.cols, PHONE.rows))

    setVisible(true)
    fitRevealedPane(pane)
    flushFrames()
    expect(grid(terminal)).toEqual(PHONE)
    terminal.dispose()
  })

  it('parks a hidden pane once a rebuild that deferred the take-over ends', async () => {
    const { terminal } = mountPane(PTY_A)
    render(<Ticks />)

    beginTerminalScrollIntentBufferRebuild(terminal)
    act(() => setFitOverride(PTY_A, 'mobile-fit', PHONE.cols, PHONE.rows))
    expect(grid(terminal)).toEqual(DESKTOP)
    endTerminalScrollIntentBufferRebuild(terminal)
    await Promise.resolve()

    expect(grid(terminal)).toEqual(PHONE)
    terminal.dispose()
  })
})
