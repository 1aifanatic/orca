import { HeadlessEmulator } from '../daemon/headless-emulator'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'

type TerminalGrid = { cols: number; rows: number }

type SerializedScreen = TerminalGrid & {
  data: string
  frameRestoreAnsi?: string
  oscLinks?: TerminalOscLinkRange[]
}

export function isOnTerminalGrid(screen: TerminalGrid, grid: TerminalGrid): boolean {
  return screen.cols === grid.cols && screen.rows === grid.rows
}

/**
 * Re-serializes a screen captured on its own grid reflowed onto `grid`, the grid every later PTY
 * byte is painted for. A desktop pane can answer at its own size after a phone fit resized the
 * PTY, and a snapshot that keeps that size makes the phone wrap live output inside a wider grid.
 */
export async function relayTerminalScreenOnGrid<T extends SerializedScreen>(
  screen: T,
  grid: TerminalGrid,
  scrollbackRows: number | undefined
): Promise<Omit<T, 'frameRestoreAnsi'>> {
  const emulator = new HeadlessEmulator({
    cols: screen.cols,
    rows: screen.rows,
    ...(scrollbackRows !== undefined ? { scrollback: scrollbackRows } : {})
  })
  try {
    await emulator.write(screen.data)
    emulator.resize(grid.cols, grid.rows)
    const relaid = emulator.getSnapshot({ scrollbackRows })
    // The frame-restore pair was cut on the old grid, so it cannot ride along.
    const { frameRestoreAnsi: _staleFrameRestore, ...metadata } = screen
    return {
      ...metadata,
      data: relaid.scrollbackAnsi + relaid.rehydrateSequences + relaid.snapshotAnsi,
      cols: relaid.cols,
      rows: relaid.rows,
      oscLinks: relaid.oscLinks
    }
  } finally {
    emulator.dispose()
  }
}
