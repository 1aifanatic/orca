import type { KeybindingInput, TextEntryClaim } from './types'
import { getKeybindingPlatform } from './definitions'
import { keyTokenFromInput } from './input'
import { hasModifier } from './parser'

// Modifiers change these editing gestures, so the field keeps every variant.
const CARET_AND_DELETION_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'Backspace',
  'Delete'
])
const VERTICAL_CARET_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'])
const TEXT_COMMAND_KEYS = new Set(['A', 'C', 'V', 'X', 'Z', 'Y'])
const RICH_TEXT_FORMATTING_KEYS = new Set(['B', 'I', 'U', 'K'])

// AppKit's Ctrl editing chords apply even though Cmd is the primary modifier.
const MAC_CONTROL_EDITING_KEYS = new Set(['A', 'B', 'D', 'E', 'F', 'H', 'K', 'O', 'T', 'Y'])
const MAC_CONTROL_VERTICAL_CARET_KEYS = new Set(['N', 'P', 'V'])
// AppKit also binds Ctrl+Option+B/F to word movement.
const MAC_CONTROL_ALT_WORD_KEYS = new Set(['B', 'F'])

// Missing claims retain every text editing gesture.
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

function usesMacControlWithoutCommand(input: KeybindingInput): boolean {
  return hasModifier(input, 'control') && !hasModifier(input, 'meta')
}

export function isChordReservedForTextEntry(
  input: KeybindingInput,
  claim: TextEntryClaim,
  platform: NodeJS.Platform
): boolean {
  const isMac = getKeybindingPlatform(platform) === 'darwin'
  // Home/End have no binding tokens; named keys retain their event values.
  const namedKey = input.key ?? ''
  if (CARET_AND_DELETION_KEYS.has(namedKey)) {
    return true
  }
  if (claim.verticalCaret && VERTICAL_CARET_KEYS.has(namedKey)) {
    return true
  }
  // Windows/Linux reserve only their exact Insert clipboard chords.
  if (namedKey === 'Insert') {
    const control = hasModifier(input, 'control')
    const shift = hasModifier(input, 'shift')
    return !isMac && control !== shift && !hasModifier(input, 'alt') && !hasModifier(input, 'meta')
  }
  // Share the matcher's layout fallback so copy/caret chords cannot drift.
  const key = keyTokenFromInput(input, platform)
  if (!key || key.length !== 1) {
    return false
  }
  if (isMac && usesMacControlWithoutCommand(input)) {
    if (hasModifier(input, 'alt')) {
      return MAC_CONTROL_ALT_WORD_KEYS.has(key)
    }
    if (MAC_CONTROL_EDITING_KEYS.has(key)) {
      return true
    }
    if (claim.verticalCaret && MAC_CONTROL_VERTICAL_CARET_KEYS.has(key)) {
      return true
    }
  }
  // Redo accepts Shift; formatting keeps its unshifted chord.
  if (TEXT_COMMAND_KEYS.has(key) && usesPrimaryModifierOnly(input, platform, true)) {
    return true
  }
  return (
    claim.richTextFormatting &&
    RICH_TEXT_FORMATTING_KEYS.has(key) &&
    usesPrimaryModifierOnly(input, platform, false)
  )
}
