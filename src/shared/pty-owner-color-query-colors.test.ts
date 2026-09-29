import { expect, it } from 'vitest'
import { DEFAULT_TERMINAL_THEME_DARK } from './terminal-theme-selection'
import { TERMINAL_THEME_CATALOG } from './terminal-themes'
import {
  ORCA_DEFAULT_COLOR_QUERY_REPLY_COLORS,
  normalizeColorQueryReplyColors,
  resolvePtyOwnerColorQueryColors
} from './pty-owner-color-query-colors'

it("falls back to the colours of Orca's default dark terminal theme", () => {
  const theme = TERMINAL_THEME_CATALOG[DEFAULT_TERMINAL_THEME_DARK]
  expect(ORCA_DEFAULT_COLOR_QUERY_REPLY_COLORS).toEqual({
    foreground: theme?.foreground,
    background: theme?.background
  })
})

it('prefers host colours, then spawn colours, then the default, skipping unusable pairs', () => {
  const host = { foreground: '#000000', background: '#111111' }
  const spawn = { foreground: '#222222', background: '#333333' }
  const unusable = { foreground: 'red', background: '#333333' }

  expect(resolvePtyOwnerColorQueryColors(host, spawn)).toEqual(host)
  expect(resolvePtyOwnerColorQueryColors(null, spawn)).toEqual(spawn)
  expect(resolvePtyOwnerColorQueryColors(unusable, spawn)).toEqual(spawn)
  expect(resolvePtyOwnerColorQueryColors(null, unusable)).toBe(
    ORCA_DEFAULT_COLOR_QUERY_REPLY_COLORS
  )
  expect(resolvePtyOwnerColorQueryColors(undefined, {})).toBe(ORCA_DEFAULT_COLOR_QUERY_REPLY_COLORS)
})

it("lets a remote viewer's creation colours outrank the host theme", () => {
  // Desktop B (light) paired to host A (dark): the pane B created is painted with B's theme.
  const hostDark = { foreground: '#ffffff', background: '#000000' }
  const remoteLight = { foreground: '#000000', background: '#ffffff' }

  expect(resolvePtyOwnerColorQueryColors(hostDark, remoteLight, true)).toEqual(remoteLight)
  expect(resolvePtyOwnerColorQueryColors(hostDark, remoteLight, false)).toEqual(hostDark)
  expect(resolvePtyOwnerColorQueryColors(hostDark, null, true)).toEqual(hostDark)
})

it('keeps only a wire pair that answers both slots', () => {
  expect(
    normalizeColorQueryReplyColors({ foreground: '#fff', background: 'rgb(1, 2, 3)' })
  ).toEqual({ foreground: '#fff', background: 'rgb(1, 2, 3)' })
  expect(normalizeColorQueryReplyColors({ foreground: '#fff' })).toBeNull()
  expect(normalizeColorQueryReplyColors({ foreground: '#fff', background: 'blue' })).toBeNull()
  expect(normalizeColorQueryReplyColors('#fff')).toBeNull()
  expect(normalizeColorQueryReplyColors(null)).toBeNull()
})
