// Text-entry focus context: which chords a declared text surface hands to the app.
import { describe, expect, it } from 'vitest'
import {
  isChordReservedForTextEntry,
  keybindingMatchesAction,
  type KeybindingInput,
  type TextEntryClaim
} from './keybindings'

const SINGLE_LINE: TextEntryClaim = { verticalCaret: false, richTextFormatting: false }
const MULTILINE: TextEntryClaim = { verticalCaret: true, richTextFormatting: false }
const RICH_TEXT: TextEntryClaim = { verticalCaret: true, richTextFormatting: true }

function chord(key: string, code: string, extra: Partial<KeybindingInput> = {}): KeybindingInput {
  return { key, code, meta: false, control: false, alt: false, shift: false, ...extra }
}

const modShiftArrowUp = (mac: boolean): KeybindingInput =>
  chord('ArrowUp', 'ArrowUp', { shift: true, meta: mac, control: !mac })
const modShiftBackspace = (mac: boolean): KeybindingInput =>
  chord('Backspace', 'Backspace', { shift: true, meta: mac, control: !mac })
const modB = (mac: boolean): KeybindingInput => chord('b', 'KeyB', { meta: mac, control: !mac })

describe('text-entry keybinding context', () => {
  const platformCases: readonly (readonly [NodeJS.Platform, boolean])[] = [
    ['darwin', true],
    ['linux', false],
    ['win32', false]
  ]

  it.each(platformCases)(
    'lets a single-line field hand Mod+Shift+ArrowUp to worktree navigation on %s',
    (platform, mac) => {
      const input = modShiftArrowUp(mac)

      expect(keybindingMatchesAction('worktree.navigateUp', input, platform)).toBe(true)
      expect(
        keybindingMatchesAction('worktree.navigateUp', input, platform, undefined, {
          context: 'text-entry',
          textEntryClaim: SINGLE_LINE
        })
      ).toBe(true)
      expect(
        keybindingMatchesAction('worktree.navigateUp', input, platform, undefined, {
          context: 'text-entry',
          textEntryClaim: MULTILINE
        })
      ).toBe(false)
    }
  )

  it('assumes the strictest claim when the caller names no surface', () => {
    expect(
      keybindingMatchesAction('worktree.navigateUp', modShiftArrowUp(true), 'darwin', undefined, {
        context: 'text-entry'
      })
    ).toBe(false)
  })

  it('keeps deletion chords with the text surface', () => {
    expect(
      keybindingMatchesAction('workspace.delete', modShiftBackspace(true), 'darwin', undefined, {
        context: 'text-entry',
        textEntryClaim: SINGLE_LINE
      })
    ).toBe(false)
  })

  it('keeps Mod+B with a rich-text editor but not with a plain field', () => {
    expect(
      keybindingMatchesAction('sidebar.left.toggle', modB(true), 'darwin', undefined, {
        context: 'text-entry',
        textEntryClaim: RICH_TEXT
      })
    ).toBe(false)
    expect(
      keybindingMatchesAction('sidebar.left.toggle', modB(true), 'darwin', undefined, {
        context: 'text-entry',
        textEntryClaim: SINGLE_LINE
      })
    ).toBe(true)
  })

  it('never hands a non-global scope to a text surface', () => {
    const modW = chord('w', 'KeyW', { meta: true })

    expect(keybindingMatchesAction('tab.close', modW, 'darwin')).toBe(true)
    expect(
      keybindingMatchesAction('tab.close', modW, 'darwin', undefined, {
        context: 'text-entry',
        textEntryClaim: SINGLE_LINE
      })
    ).toBe(false)
  })

  it('leaves app, terminal and browser contexts untouched', () => {
    const modP = chord('p', 'KeyP', { meta: true })

    expect(keybindingMatchesAction('worktree.quickOpen', modP, 'darwin')).toBe(true)
    expect(
      keybindingMatchesAction('worktree.quickOpen', modP, 'darwin', undefined, { context: 'app' })
    ).toBe(true)
    expect(
      keybindingMatchesAction('worktree.quickOpen', modP, 'darwin', undefined, {
        context: 'terminal',
        terminalShortcutPolicy: 'orca-first'
      })
    ).toBe(true)
  })
})

describe('isChordReservedForTextEntry', () => {
  it.each(['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Backspace', 'Delete'])(
    'reserves %s for every text surface',
    (key) => {
      expect(isChordReservedForTextEntry(chord(key, key), SINGLE_LINE, 'darwin')).toBe(true)
    }
  )

  it.each(['a', 'c', 'v', 'x', 'z', 'y'])('reserves the Mod+%s text command', (key) => {
    expect(
      isChordReservedForTextEntry(
        chord(key, `Key${key.toUpperCase()}`, { meta: true }),
        SINGLE_LINE,
        'darwin'
      )
    ).toBe(true)
  })

  it('reserves redo but not a Shift-modified formatting chord', () => {
    expect(
      isChordReservedForTextEntry(
        chord('z', 'KeyZ', { meta: true, shift: true }),
        SINGLE_LINE,
        'darwin'
      )
    ).toBe(true)
    expect(
      isChordReservedForTextEntry(
        chord('b', 'KeyB', { meta: true, shift: true }),
        RICH_TEXT,
        'darwin'
      )
    ).toBe(false)
  })

  it('reads the primary modifier per platform', () => {
    const ctrlA = chord('a', 'KeyA', { control: true })

    expect(isChordReservedForTextEntry(ctrlA, SINGLE_LINE, 'linux')).toBe(true)
    expect(isChordReservedForTextEntry(ctrlA, SINGLE_LINE, 'darwin')).toBe(false)
  })

  it('ignores a synthetic input that carries no key', () => {
    expect(isChordReservedForTextEntry({ doubleTapModifier: 'Cmd' }, RICH_TEXT, 'darwin')).toBe(
      false
    )
  })
})
