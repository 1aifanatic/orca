// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { PaneManagerOptions } from '@/lib/pane-manager/pane-manager-types'
import type { TerminalPaneLayoutNode } from '../../../../shared/terminal-tab-types'
import type { PtyTransport } from './pty-transport-types'
import { serializePaneTree } from './layout-serialization'
import { installIpcPtyWindow, restorePtySpecWindow } from './pty-transport-test-harness'

// Why: happy-dom has no canvas, so xterm cannot open; reconciliation never touches the terminal.
vi.mock('@/lib/pane-manager/pane-lifecycle', async (importOriginal) => {
  const actual: object = await importOriginal()
  return { ...actual, openTerminal: vi.fn() }
})

const { PaneManager } = await import('@/lib/pane-manager/pane-manager')
const { reconcileMountedTerminalLayout } = await import('./terminal-live-layout-reconciliation')

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const NEW = '33333333-3333-4333-8333-333333333333'

const leaf = (leafId: string): TerminalPaneLayoutNode => ({ type: 'leaf', leafId })
const split = (
  first: TerminalPaneLayoutNode,
  second: TerminalPaneLayoutNode,
  ratio?: number
): TerminalPaneLayoutNode => ({
  type: 'split',
  direction: 'vertical',
  first,
  second,
  ...(ratio !== undefined ? { ratio } : {})
})

type Mounted = {
  manager: InstanceType<typeof PaneManager>
  root: HTMLDivElement
  onLayoutChanged: Mock<NonNullable<PaneManagerOptions['onLayoutChanged']>>
  onPaneCreated: Mock<NonNullable<PaneManagerOptions['onPaneCreated']>>
  onPaneClosed: Mock<NonNullable<PaneManagerOptions['onPaneClosed']>>
}

const mounted: Mounted[] = []

function mount(
  leafIds: string[],
  wiring: Partial<Pick<PaneManagerOptions, 'onPaneCreated' | 'onPaneClosed'>> = {}
): Mounted {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const onLayoutChanged = vi.fn()
  const onPaneCreated = vi.fn(wiring.onPaneCreated)
  const onPaneClosed = vi.fn(wiring.onPaneClosed)
  const manager = new PaneManager(root, {
    linkOpenHint: () => '',
    onLayoutChanged,
    onPaneCreated,
    onPaneClosed
  })
  const [first, ...rest] = leafIds
  let previous = manager.createInitialPane({ leafId: first })
  for (const leafId of rest) {
    previous = manager.splitPane(previous.id, 'vertical', { leafId })!
  }
  onLayoutChanged.mockClear()
  onPaneCreated.mockClear()
  onPaneClosed.mockClear()
  const view = { manager, root, onLayoutChanged, onPaneCreated, onPaneClosed }
  mounted.push(view)
  return view
}

function reconcile(
  view: Mounted,
  root: TerminalPaneLayoutNode,
  options: { ptyIdsByLeafId?: Record<string, string>; added?: string[]; removed?: string[] } = {}
): boolean {
  return reconcileMountedTerminalLayout(
    view.manager,
    { root, ptyIdsByLeafId: options.ptyIdsByLeafId ?? {} },
    { added: new Set(options.added ?? []), removed: new Set(options.removed ?? []) }
  )
}

const tree = (view: Mounted): TerminalPaneLayoutNode | null =>
  view.root.firstElementChild instanceof HTMLElement
    ? serializePaneTree(view.root.firstElementChild)
    : null

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  for (const view of mounted.splice(0)) {
    view.manager.destroy()
    view.root.remove()
  }
  vi.unstubAllGlobals()
})

describe('reconcileMountedTerminalLayout', () => {
  it('spawns an inserted unbound leaf once, through the normal split placement', () => {
    const view = mount([A])
    const layout = split(leaf(A), leaf(NEW))

    expect(reconcile(view, layout)).toBe(true)
    expect(reconcile(view, layout)).toBe(false)

    expect(view.onPaneCreated).toHaveBeenCalledTimes(1)
    const [pane, hints] = view.onPaneCreated.mock.calls[0]
    expect(pane.leafId).toBe(NEW)
    expect(hints).not.toHaveProperty('ptyId')
    expect(hints?.placement).toMatchObject({ kind: 'split', parentLeafId: A })
    expect(tree(view)).toEqual(layout)
  })

  it('attaches an inserted bound leaf to its PTY', () => {
    const view = mount([A])
    reconcile(view, split(leaf(A), leaf(NEW)), { ptyIdsByLeafId: { [NEW]: 'pty-new' } })
    expect(view.onPaneCreated.mock.calls[0]?.[1]).toMatchObject({ ptyId: 'pty-new' })
  })

  it('persists nothing itself: only the split reports its own layout change', () => {
    const view = mount([A])
    reconcile(view, split(leaf(A), leaf(NEW), 0.3))
    expect(view.onLayoutChanged).toHaveBeenCalledTimes(1)
    expect(view.onLayoutChanged).toHaveBeenCalledWith()
  })

  it('detaches a removed leaf instead of closing it', () => {
    const view = mount([A, B])
    expect(reconcile(view, leaf(A))).toBe(true)
    expect(view.onPaneClosed).toHaveBeenCalledTimes(1)
    expect(view.onPaneClosed.mock.calls[0]?.[1]).toMatchObject({ leafId: B, reason: 'detach' })
    expect(tree(view)).toEqual(leaf(A))
  })

  it('keeps a pending pane main has not named yet', () => {
    const view = mount([A, B])
    expect(reconcile(view, leaf(A), { added: [B] })).toBe(false)
    expect(view.onPaneClosed).not.toHaveBeenCalled()
    expect(view.manager.getPanes().map((pane) => pane.leafId)).toEqual([A, B])
  })

  it('does not bring back a pane closed here that an older layout still names', () => {
    const view = mount([A])
    expect(reconcile(view, split(leaf(A), leaf(B)), { removed: [B] })).toBe(false)
    expect(view.onPaneCreated).not.toHaveBeenCalled()
    expect(tree(view)).toEqual(leaf(A))
  })

  it('removes before inserting, so the new leaf anchors on a pane that stays', () => {
    const view = mount([A, B])
    const layout = split(leaf(A), leaf(NEW))
    reconcile(view, layout)
    expect(tree(view)).toEqual(layout)
  })

  it('applies a ratio change in place without remounting', () => {
    const view = mount([A, B])
    const before = view.manager.getPanes().map((pane) => [pane.id, pane.container])
    expect(reconcile(view, split(leaf(A), leaf(B), 0.25))).toBe(false)
    expect(tree(view)).toEqual(split(leaf(A), leaf(B), 0.25))
    expect(view.manager.getPanes().map((pane) => [pane.id, pane.container])).toEqual(before)
    expect(view.onPaneCreated).not.toHaveBeenCalled()
    expect(view.onLayoutChanged).not.toHaveBeenCalled()
  })

  it('leaves a divider the user is dragging alone', () => {
    const view = mount([A, B])
    view.root.querySelector('.pane-divider')?.classList.add('is-dragging')
    reconcile(view, split(leaf(A), leaf(B), 0.25))
    expect(tree(view)).toEqual(split(leaf(A), leaf(B)))
  })
})

describe('a leaf main moved to another tab', () => {
  const originalWindow = globalThis.window
  let deliver: ((payload: { id: string; data: string }) => void) | null = null

  beforeEach(() => {
    vi.resetModules()
    deliver = null
    installIpcPtyWindow(originalWindow, {
      data: (callback) => {
        deliver = callback
      }
    })
  })

  afterEach(() => {
    restorePtySpecWindow(originalWindow)
  })

  it.each(['source first', 'destination first'] as const)(
    'is never killed and has one output owner (%s)',
    async (order) => {
      const { createIpcPtyTransport } = await import('./pty-transport')
      const received: string[] = []
      // TerminalPane's wiring: a hinted PTY attaches, and a detached pane releases without a kill.
      const wiring = (
        tab: string,
        transports = new Map<number, PtyTransport>()
      ): Parameters<typeof mount>[1] => ({
        onPaneCreated: (pane, hints) => {
          const transport = createIpcPtyTransport({})
          transport.attach({
            existingPtyId: hints?.ptyId ?? `pty-${pane.leafId}`,
            callbacks: { onData: (data) => received.push(`${tab}:${data}`) }
          })
          transports.set(pane.id, transport)
        },
        onPaneClosed: (paneId, closed) => {
          const transport = transports.get(paneId)
          return closed?.reason === 'detach'
            ? transport?.detach?.({ preserveExitObserver: false })
            : transport?.destroy?.()
        }
      })
      const source = mount([A, B], wiring('source'))
      const destination = mount([A], wiring('destination'))
      const moveOut = (): boolean => reconcile(source, leaf(A))
      const moveIn = (): boolean =>
        reconcile(destination, split(leaf(A), leaf(B)), { ptyIdsByLeafId: { [B]: `pty-${B}` } })

      if (order === 'source first') {
        moveOut()
        moveIn()
      } else {
        moveIn()
        moveOut()
      }
      deliver?.({ id: `pty-${B}`, data: 'live' })

      expect(window.api.pty.kill).not.toHaveBeenCalled()
      expect(received).toEqual(['destination:live'])
    }
  )
})
