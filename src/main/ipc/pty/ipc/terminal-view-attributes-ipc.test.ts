import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { TerminalOscColorQueryReplyColors } from '../../../../shared/terminal-osc-color-reply'
import { LocalPtyProvider } from '../../../providers/local-pty-provider'
import {
  _resetTerminalViewAttributesForTest,
  setTerminalViewAttributes
} from '../../../runtime/terminal-view-attribute-store'
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

  it('leaves colours a renderer already pushed alone', () => {
    setTerminalViewAttributes({
      foreground: [0, 0, 0],
      background: [0x12, 0x34, 0x56],
      cursor: [0, 0, 0],
      ansi: Array.from({ length: 256 }, (): [number, number, number] => [0, 0, 0]),
      colorSchemeMode: 'light',
      cursorStyle: 'block',
      cursorBlink: false
    })
    const owner = new RecordingProvider()
    setLocalPtyProvider(owner)

    installTerminalViewAttributesIpc({ getSettings: () => settings })

    expect(owner.pushes).toEqual([])
  })
})
