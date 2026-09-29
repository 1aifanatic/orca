import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { TerminalOscColorQueryReplyColors } from '../../../../shared/terminal-osc-color-reply'
import { LocalPtyProvider } from '../../../providers/local-pty-provider'
import {
  _resetTerminalViewAttributesForTest,
  getTerminalViewAttributes,
  reassertDesktopTerminalViewerColors,
  setTerminalViewAttributes,
  setTerminalViewerColors
} from '../../../runtime/terminal-view-attribute-store'
import type { TerminalViewAttributes } from '../../../../shared/terminal-view-attributes'
import {
  _resetColorQueryReplyColorsForTest,
  getLocalPtyProvider,
  setLocalPtyProvider
} from '../provider/registry'
import { installTerminalViewAttributesIpc } from './terminal-view-attributes-ipc'

class RecordingProvider extends LocalPtyProvider {
  readonly pushes: TerminalOscColorQueryReplyColors[] = []

  override setColorQueryReplyColors(colors: TerminalOscColorQueryReplyColors): void {
    this.pushes.push(colors)
  }
}

const DESKTOP_ATTRIBUTES: TerminalViewAttributes = {
  foreground: [0, 0, 0],
  background: [0x12, 0x34, 0x56],
  cursor: [0, 0, 0],
  ansi: Array.from({ length: 256 }, (): [number, number, number] => [0, 0, 0]),
  colorSchemeMode: 'light',
  cursorStyle: 'block',
  cursorBlink: false
}
const DESKTOP = { foreground: '#000000', background: '#123456' }
const CLIENT = { foreground: '#2e3434', background: '#ffffff' }

describe('seeding PTY owner colours from saved settings', () => {
  const originalLocal = getLocalPtyProvider()
  const settings = getDefaultSettings('/tmp')

  afterEach(() => {
    _resetTerminalViewAttributesForTest()
    _resetColorQueryReplyColorsForTest()
    setLocalPtyProvider(originalLocal)
  })

  it('seeds a light-appearance host with its light theme before any renderer push', () => {
    const owner = new RecordingProvider()
    setLocalPtyProvider(owner)

    installTerminalViewAttributesIpc({
      getSettings: () => ({ ...settings, theme: 'system' }),
      options: { systemPrefersDark: () => false }
    })

    expect(owner.pushes).toEqual([{ foreground: '#2e3434', background: '#ffffff' }])
  })

  it('seeds a host with no display from its saved dark theme', () => {
    const owner = new RecordingProvider()
    setLocalPtyProvider(owner)

    installTerminalViewAttributesIpc({ getSettings: () => ({ ...settings, theme: 'dark' }) })

    expect(owner.pushes).toEqual([{ foreground: '#ffffff', background: '#282c34' }])
  })

  it('publishes colours a renderer already pushed instead of the saved theme', () => {
    setTerminalViewAttributes(DESKTOP_ATTRIBUTES)
    const owner = new RecordingProvider()
    setLocalPtyProvider(owner)

    installTerminalViewAttributesIpc({ getSettings: () => settings })

    expect(owner.pushes).toEqual([DESKTOP])
  })
})

describe('one viewer colour value for every PTY owner', () => {
  const originalLocal = getLocalPtyProvider()

  afterEach(() => {
    _resetTerminalViewAttributesForTest()
    _resetColorQueryReplyColorsForTest()
    setLocalPtyProvider(originalLocal)
  })

  function install(): RecordingProvider {
    const owner = new RecordingProvider()
    setLocalPtyProvider(owner)
    installTerminalViewAttributesIpc({})
    return owner
  }

  it('lets the viewer that acted last answer, without touching the desktop attributes', () => {
    const owner = install()
    setTerminalViewAttributes(DESKTOP_ATTRIBUTES)

    setTerminalViewerColors(CLIENT)

    expect(owner.pushes).toEqual([DESKTOP, CLIENT])
    // The hidden-pane responder still answers OSC 4/12 from the desktop's own palette.
    expect(getTerminalViewAttributes()).toBe(DESKTOP_ATTRIBUTES)
  })

  it('hands the panes back to this desktop when its window regains focus', () => {
    const owner = install()
    setTerminalViewAttributes(DESKTOP_ATTRIBUTES)
    setTerminalViewerColors(CLIENT)

    reassertDesktopTerminalViewerColors()

    expect(owner.pushes).toEqual([DESKTOP, CLIENT, DESKTOP])
  })

  it('treats an identical renderer re-push as this desktop acting again', () => {
    const owner = install()
    setTerminalViewAttributes(DESKTOP_ATTRIBUTES)
    setTerminalViewerColors(CLIENT)

    setTerminalViewAttributes({ ...DESKTOP_ATTRIBUTES })

    expect(owner.pushes).toEqual([DESKTOP, CLIENT, DESKTOP])
  })

  it('does not re-notify owners when a focus changes nothing', () => {
    const owner = install()
    setTerminalViewAttributes(DESKTOP_ATTRIBUTES)

    reassertDesktopTerminalViewerColors()
    setTerminalViewerColors({ ...DESKTOP })

    expect(owner.pushes).toEqual([DESKTOP])
  })
})
