import { vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { SerializeAddon } from '@xterm/addon-serialize'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'

export const DESKTOP = { cols: 200, rows: 50 }
export const PHONE = { cols: 47, rows: 40 }

/** A desktop pane with a real xterm and serializer; hidden means a `display: none` worktree. */
export function createHiddenPane(
  visible = false,
  id = 1
): {
  pane: ManagedPane
  terminal: Terminal
  setVisible: (next: boolean) => void
} {
  let shown = visible
  const worktree = document.createElement('div')
  worktree.style.display = shown ? 'block' : 'none'
  const container = document.createElement('div')
  container.getBoundingClientRect = () =>
    DOMRect.fromRect(shown ? { width: 1600, height: 900 } : { width: 0, height: 0 })
  worktree.appendChild(container)
  document.body.appendChild(worktree)
  const terminal = new Terminal({ ...DESKTOP, allowProposedApi: true })
  const serializeAddon = new SerializeAddon()
  terminal.loadAddon(serializeAddon)
  const pane = {
    id,
    terminal,
    container,
    xtermContainer: container,
    serializeAddon,
    // The browser measures nothing inside a display:none subtree.
    fitAddon: {
      fit: vi.fn(() => terminal.resize(DESKTOP.cols, DESKTOP.rows)),
      proposeDimensions: () => (shown ? DESKTOP : undefined)
    },
    pendingSplitScrollState: null
  }
  const setVisible = (next: boolean): void => {
    shown = next
    worktree.style.display = next ? 'block' : 'none'
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: pane-fit and the serializer read only the fields built above.
  return { pane: pane as unknown as ManagedPane, terminal, setVisible }
}
