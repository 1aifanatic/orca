// #11315: SSH TUI repaints reach Electron main through onPtyData; tail work must stay linear in bytes.
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import * as ansiNormalization from './terminal-ansi-normalization'
import { expectLinearRevisitWork, measureRowWork } from './terminal-tail-redraw-work-test-harness'

const ESC = '\x1b'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

// An ask_user-style panel: climb to the top, then clear and repaint each full-width row.
function panelFrames(width: number, frames: number): string {
  const frame = `${ESC}[4A${['title', 'option a', 'option b', 'hint']
    .map((label) => `\r${ESC}[2K${label} ${'─'.repeat(width - label.length - 1)}\n`)
    .join('')}`
  return frame.repeat(frames)
}

function runtimeWithLeaf(ptyId: string): { runtime: OrcaRuntimeService; leaf: unknown } {
  const runtime = new OrcaRuntimeService()
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [{ tabId: 'tab-1', worktreeId: 'wt-1', activeLeafId: LEAF_ID, layout: null, title: '' }],
    leaves: [
      {
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        leafId: LEAF_ID,
        paneRuntimeId: 1,
        ptyId,
        paneTitle: null
      }
    ]
  })
  const leaves: unknown = Reflect.get(runtime, 'leaves')
  if (!(leaves instanceof Map) || leaves.size !== 1) {
    throw new Error('Expected exactly one runtime leaf')
  }
  return { runtime, leaf: leaves.values().next().value }
}

function readTail(runtime: OrcaRuntimeService, ptyId: string): string[] {
  const ptys: unknown = Reflect.get(runtime, 'ptysById')
  const pty: unknown = ptys instanceof Map ? ptys.get(ptyId) : undefined
  const lines: unknown = pty && typeof pty === 'object' ? Reflect.get(pty, 'tailBuffer') : undefined
  if (!Array.isArray(lines)) {
    throw new Error('PTY record has no tail')
  }
  return lines.map(String)
}

describe('onPtyData redraw cost', () => {
  it('replays a full-history TUI redraw without splicing the tail once per line', async () => {
    const ptyId = 'pty-replay'
    const { runtime } = runtimeWithLeaf(ptyId)
    try {
      runtime.onPtyData(ptyId, 'history\n'.repeat(2_000), 0)
      // The panel leaves the cursor parked inside it, so later chunks take the redraw model.
      runtime.onPtyData(ptyId, `${panelFrames(120, 1)}${ESC}[2A`, 1)
      const replay = Array.from({ length: 20_000 }, (_, index) => `line ${index}\r\n`).join('')
      const splice = vi.spyOn(Array.prototype, 'splice')
      let spliceCalls: number
      try {
        runtime.onPtyData(ptyId, `${ESC}[2J${ESC}[H${ESC}[3J${replay}`, 2)
        spliceCalls = splice.mock.calls.length
      } finally {
        splice.mockRestore()
      }
      // One splice per capped row made a replay cost O(lines x tail cap) on Electron main.
      expect(spliceCalls).toBeLessThan(100)
      expect(readTail(runtime, ptyId).at(-1)).toBe('line 19999')
    } finally {
      await runtime.onPtyExit(ptyId, 0)
    }
  })

  it('normalizes a chunk once when a diverged leaf carries the same escape prefix', async () => {
    const ptyId = 'pty-diverged'
    const { runtime, leaf } = runtimeWithLeaf(ptyId)
    if (!leaf || typeof leaf !== 'object') {
      throw new Error('Runtime leaf missing')
    }
    // Different retained history sends the leaf down its own tail update.
    Reflect.set(leaf, 'tailBuffer', ['leaf-only history'])
    Reflect.set(leaf, 'tailLinesTotal', 1)
    const normalize = vi.spyOn(ansiNormalization, 'normalizeTerminalChunk')
    try {
      const chunk = panelFrames(80, 3)
      runtime.onPtyData(ptyId, chunk, 1_000)
      expect(normalize.mock.calls.filter(([data]) => data === chunk)).toHaveLength(1)
      expect(Reflect.get(leaf, 'tailBuffer')).toContain(`hint ${'─'.repeat(75)}`)
    } finally {
      normalize.mockRestore()
      await runtime.onPtyExit(ptyId, 0)
    }
  })

  it('keeps live row work linear across the revisit matrix', async () => {
    let index = 0
    const exits: (void | Promise<void>)[] = []
    // The PTY and its leaf can each update a tail model per chunk.
    expectLinearRevisitWork(
      (text) => {
        const ptyId = `pty-revisit-${index++}`
        const { runtime } = runtimeWithLeaf(ptyId)
        runtime.onPtyData(ptyId, text, 1)
        exits.push(runtime.onPtyExit(ptyId, 0))
      },
      { revisits: 150, models: 2 }
    )
    await Promise.all(exits)
  })

  it('does not rebuild a wide row the cursor only revisits', async () => {
    const ptyId = 'pty-revisit'
    const width = 32_000
    const { runtime } = runtimeWithLeaf(ptyId)
    try {
      const text = `${ESC}[1A\rpanel${' '.repeat(width)}\n${`${ESC}[1A\n`.repeat(4_000)}`
      // A trim or join per newline rebuilt the whole row 4,000 times and froze main for seconds.
      expect(measureRowWork(() => runtime.onPtyData(ptyId, text, 1))).toBeLessThan(2 * width)
      expect(readTail(runtime, ptyId)).toEqual(['panel'])
    } finally {
      await runtime.onPtyExit(ptyId, 0)
    }
  })
})
