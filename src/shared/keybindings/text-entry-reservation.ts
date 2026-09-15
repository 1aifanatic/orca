import type { KeybindingInput, TextEntryClaim } from './types'
import { getKeybindingPlatform } from './definitions'
import { hasModifier } from './parser'

/**
 * Caret and deletion gestures a text surface owns under any modifier combination:
 * macOS alone maps Mod, Alt and Shift onto each of these.
 */
const CARET_AND_DELETION_KEYS = new Set([
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

/**
 * macOS binds Ctrl+letter to editing commands in every text view, so these are text
 * gestures there even though Ctrl is not the platform's primary modifier. Taken from
 * AppKit's StandardKeyBinding.dict: ^a/^e move within the paragraph, ^b/^f move by
 * character, ^d/^h delete, ^k kills to the end, ^o inserts, ^t transposes, ^y yanks.
 * ^l is deliberately absent — it only recenters the view, leaving caret and content
 * untouched, so an app action may claim it.
 */
const MAC_CONTROL_EDITING_KEYS = new Set(['a', 'b', 'd', 'e', 'f', 'h', 'k', 'o', 't', 'y'])
/** ^n/^p/^v move by line or page, so only a surface with vertical caret movement owns them. */
const MAC_CONTROL_VERTICAL_CARET_KEYS = new Set(['n', 'p', 'v'])

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

/** Shift is allowed: AppKit pairs every ^key with a ^$key that extends the selection. */
function usesMacControlOnly(input: KeybindingInput): boolean {
  return hasModifier(input, 'control') && !hasModifier(input, 'meta') && !hasModifier(input, 'alt')
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
  if (CARET_AND_DELETION_KEYS.has(key)) {
    return true
  }
  if (claim.verticalCaret && VERTICAL_CARET_KEYS.has(key)) {
    return true
  }
  const isMac = getKeybindingPlatform(platform) === 'darwin'
  // Why bare Insert stays available: Windows and Linux keep the legacy clipboard chords
  // on Ctrl+Insert and Shift+Insert, but nothing binds Insert alone in a text field, and
  // macOS binds no Insert key at all.
  if (key === 'Insert') {
    return !isMac && (hasModifier(input, 'control') || hasModifier(input, 'shift'))
  }
  if (key.length !== 1) {
    return false
  }
  const letter = key.toLowerCase()
  if (isMac && usesMacControlOnly(input)) {
    if (MAC_CONTROL_EDITING_KEYS.has(letter)) {
      return true
    }
    if (claim.verticalCaret && MAC_CONTROL_VERTICAL_CARET_KEYS.has(letter)) {
      return true
    }
  }
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
