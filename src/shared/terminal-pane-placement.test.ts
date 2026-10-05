import { describe, expect, it } from 'vitest'
import { parseTerminalPanePlacement } from './terminal-pane-placement'

const LEAF = '11111111-1111-4111-8111-111111111111'

describe('parseTerminalPanePlacement', () => {
  it('accepts each kind', () => {
    const newTab = {
      kind: 'new-tab',
      row: { title: 'Agent', color: null, launchAgent: 'codex', viewMode: 'chat', createdAt: 9 },
      size: { cols: 120, rows: 40 }
    }
    const split = {
      kind: 'split',
      parentLeafId: LEAF,
      direction: 'vertical',
      ratio: 0.25,
      proposedRoot: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: 'b' },
        second: { type: 'leaf', leafId: LEAF }
      }
    }
    expect(parseTerminalPanePlacement(newTab)).toEqual(newTab)
    expect(parseTerminalPanePlacement(split)).toEqual(split)
    expect(parseTerminalPanePlacement({ kind: 'root' })).toEqual({ kind: 'root' })
  })

  it('strips fields a newer sender adds', () => {
    expect(parseTerminalPanePlacement({ kind: 'root', future: 1 })).toEqual({ kind: 'root' })
  })

  it.each([
    ['absent', undefined],
    ['a future kind', { kind: 'floating' }],
    ['a legacy parent leaf id', { kind: 'split', parentLeafId: 'pane-1', direction: 'vertical' }],
    ['a bad direction', { kind: 'split', parentLeafId: LEAF, direction: 'diagonal' }],
    [
      'a ratio out of range',
      { kind: 'split', parentLeafId: LEAF, direction: 'vertical', ratio: 2 }
    ],
    [
      'a malformed proposed tree',
      { kind: 'split', parentLeafId: LEAF, direction: 'vertical', proposedRoot: { type: 'x' } }
    ],
    [
      'an unknown agent',
      { kind: 'new-tab', row: { launchAgent: 'nope', createdAt: 1 }, size: { cols: 1, rows: 1 } }
    ],
    ['a new tab without size', { kind: 'new-tab', row: { createdAt: 1 } }]
  ])('rejects %s', (_name, value) => {
    expect(parseTerminalPanePlacement(value)).toBeNull()
  })
})
