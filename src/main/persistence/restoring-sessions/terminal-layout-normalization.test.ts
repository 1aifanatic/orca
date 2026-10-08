import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import {
  collectLayoutLeafIdsInOrder,
  normalizeTerminalLayoutSnapshotForPersistence
} from './terminal-layout-normalization'

const STABLE_A = '11111111-1111-4111-8111-111111111111'
const STABLE_B = '22222222-2222-4222-8222-222222222222'

function splitOf(firstLeafId: string, secondLeafId: string): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: firstLeafId },
      second: { type: 'leaf', leafId: secondLeafId }
    },
    activeLeafId: firstLeafId,
    expandedLeafId: null
  }
}

describe('normalizeTerminalLayoutSnapshotForPersistence', () => {
  it('never hands a preferred id to a leaf that another input leaf already owns', () => {
    // The preferred id at index 0 is the stable id the *second* input leaf keeps; reusing it here
    // would recreate the duplicate and merge both leaves' pty/buffer/scrollback/title records.
    const input: TerminalLayoutSnapshot = {
      ...splitOf('pane:1', STABLE_B),
      ptyIdsByLeafId: { 'pane:1': 'pty-1', [STABLE_B]: 'pty-2' }
    }

    const normalized = normalizeTerminalLayoutSnapshotForPersistence(
      input,
      splitOf(STABLE_B, STABLE_A)
    )

    const leafIds = collectLayoutLeafIdsInOrder(normalized.snapshot.root)
    expect(new Set(leafIds).size).toBe(2)
    expect(leafIds[1]).toBe(STABLE_B)
    expect(normalized.snapshot.ptyIdsByLeafId).toEqual({
      [leafIds[0]]: 'pty-1',
      [STABLE_B]: 'pty-2'
    })
  })

  it('still adopts an unclaimed preferred id for a legacy leaf', () => {
    const normalized = normalizeTerminalLayoutSnapshotForPersistence(
      splitOf('pane:1', STABLE_B),
      splitOf(STABLE_A, STABLE_B)
    )

    expect(collectLayoutLeafIdsInOrder(normalized.snapshot.root)).toEqual([STABLE_A, STABLE_B])
  })
})

describe('normalizeTerminalLayoutSnapshotForPersistence pane metadata', () => {
  it('keeps a null focused pane and remaps the expanded and chat panes with their leaf', () => {
    const normalized = normalizeTerminalLayoutSnapshotForPersistence(
      {
        ...splitOf('pane:1', 'pane:2'),
        activeLeafId: null,
        expandedLeafId: 'pane:2',
        chatLeafId: 'pane:1'
      },
      splitOf(STABLE_A, STABLE_B)
    )

    expect(normalized.snapshot).toMatchObject({
      activeLeafId: null,
      expandedLeafId: STABLE_B,
      chatLeafId: STABLE_A
    })
  })

  it('drops an expanded or chat pane that names a leaf no longer in the tree', () => {
    const normalized = normalizeTerminalLayoutSnapshotForPersistence({
      ...splitOf(STABLE_A, STABLE_B),
      expandedLeafId: 'pane:gone',
      chatLeafId: 'pane:gone'
    })

    expect(normalized.snapshot.expandedLeafId).toBeNull()
    expect(normalized.snapshot).not.toHaveProperty('chatLeafId')
  })

  it('gives a createTab-era empty layout the prior tree back', () => {
    const normalized = normalizeTerminalLayoutSnapshotForPersistence(
      { root: null, activeLeafId: null, expandedLeafId: null },
      { ...splitOf(STABLE_A, STABLE_B), activeLeafId: STABLE_B }
    )

    expect(collectLayoutLeafIdsInOrder(normalized.snapshot.root)).toEqual([STABLE_A, STABLE_B])
    expect(normalized.snapshot.activeLeafId).toBe(STABLE_B)
  })
})
