import type { KeybindingInput, TextEntryClaim } from './types'
import { getKeybindingPlatform } from './definitions'
import { hasModifier } from './parser'

/**
 * Caret and deletion gestures a text surface owns under any modifier combination:
 * macOS alone maps Mod, Alt and Shift onto each of these.
 */
const HORIZONTAL_CARET_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'Backspace',
  'Delete'
])
const VERTICAL_CARET_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'])
/** Selection, clipboard and undo/redo, which every text surface owns. */
const TEXT_COMMAND_KEYS = new Set(['a', 'c', 'v', 'x', 'z', 'y'])
const RICH_TEXT_FORMATTING_KEYS = new Set(['b', 'i', 'u', 'k'])

/** Assumed when a caller names the text-entry context without describing the surface. */
export const STRICTEST_TEXT_ENTRY_CLAIM: TextEntryClaim = {
  verticalCaret: true,
  richTextFormatting: true
}

function usesPrimaryModifierOnly(
  input: KeybindingInput,
  platform: NodeJS.Platform,
  allowShift: boolean
): boolean {
  const isMac = getKeybindingPlatform(platform) === 'darwin'
  const primary = hasModifier(input, isMac ? 'meta' : 'control')
  const secondary = hasModifier(input, isMac ? 'control' : 'meta')
  return (
    primary &&
    !secondary &&
    !hasModifier(input, 'alt') &&
    (allowShift || !hasModifier(input, 'shift'))
  )
}

/**
 * Whether the focused text surface owns this chord, in which case no app action
 * may claim it. Everything else stays available to the app.
 */
export function isChordReservedForTextEntry(
  input: KeybindingInput,
  claim: TextEntryClaim,
  platform: NodeJS.Platform
): boolean {
  const key = input.key
  if (!key) {
    return false
  }
  if (HORIZONTAL_CARET_KEYS.has(key)) {
    return true
  }
  if (claim.verticalCaret && VERTICAL_CARET_KEYS.has(key)) {
    return true
  }
  if (key.length !== 1) {
    return false
  }
  const letter = key.toLowerCase()
  // Why Shift is allowed here but not for formatting: Mod+Shift+Z is redo, while bold stays Mod+B.
  if (TEXT_COMMAND_KEYS.has(letter) && usesPrimaryModifierOnly(input, platform, true)) {
    return true
  }
  return (
    claim.richTextFormatting &&
    RICH_TEXT_FORMATTING_KEYS.has(letter) &&
    usesPrimaryModifierOnly(input, platform, false)
  )
}
