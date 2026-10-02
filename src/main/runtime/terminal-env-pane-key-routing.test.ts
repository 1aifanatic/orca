import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import {
  collectMovedEnvPaneKeys,
  resolveTerminalPaneForEnvPaneKey,
  type EnvPaneKeyTerminal
} from './terminal-env-pane-key-routing'

const OLD = makePaneKey('tab-old', '11111111-1111-4111-8111-111111111111')
const NEW = makePaneKey('tab-new', '22222222-2222-4222-8222-222222222222')
const OTHER = makePaneKey('tab-other', '33333333-3333-4333-8333-333333333333')

type Terminal = EnvPaneKeyTerminal & { exited?: boolean; mounted?: string[] }

function source(terminals: Terminal[]) {
  return {
    terminals,
    isLive: (terminal: Terminal) => terminal.exited !== true,
    currentPaneKeys: (terminal: Terminal) => terminal.mounted ?? []
  }
}

const moved: Terminal = { ptyId: 'pty-1', paneKey: NEW, envPaneKey: OLD }

describe('resolveTerminalPaneForEnvPaneKey', () => {
  it('resolves an exported key to the pane its live terminal shows now', () => {
    expect(resolveTerminalPaneForEnvPaneKey(OLD, source([moved]))).toBe(NEW)
  })

  it('prefers the mounted leaf over the recorded surface', () => {
    expect(
      resolveTerminalPaneForEnvPaneKey(OLD, source([{ ...moved, paneKey: null, mounted: [NEW] }]))
    ).toBe(NEW)
  })

  it.each<[string, Terminal[]]>([
    ['no terminal exported the key', [{ ptyId: 'pty-1', paneKey: NEW, envPaneKey: OTHER }]],
    ['the terminal never moved', [{ ptyId: 'pty-1', paneKey: OLD, envPaneKey: OLD }]],
    ['the terminal exited', [{ ...moved, exited: true }]],
    [
      'another live terminal shows that pane now',
      [moved, { ptyId: 'pty-2', paneKey: OLD, envPaneKey: OLD }]
    ],
    [
      'two live terminals exported the same key',
      [moved, { ptyId: 'pty-2', paneKey: OTHER, envPaneKey: OLD }]
    ],
    ['the terminal is mounted in more than one pane', [{ ...moved, mounted: [NEW, OTHER] }]],
    ['the terminal has no surface', [{ ...moved, paneKey: null }]],
    ['a host predating the field reported none', [{ ptyId: 'pty-1', paneKey: NEW }]]
  ])('refuses to guess when %s', (_case, terminals) => {
    expect(resolveTerminalPaneForEnvPaneKey(OLD, source(terminals))).toBeUndefined()
  })

  it('ignores an exited terminal that still records the pane', () => {
    expect(
      resolveTerminalPaneForEnvPaneKey(
        OLD,
        source([moved, { ptyId: 'pty-2', paneKey: OLD, envPaneKey: OLD, exited: true }])
      )
    ).toBe(NEW)
  })

  it('rejects keys that are not stable pane keys', () => {
    expect(resolveTerminalPaneForEnvPaneKey('tab-old:1', source([moved]))).toBeUndefined()
  })
})

describe('collectMovedEnvPaneKeys', () => {
  it('lists only the exported keys whose terminal now shows another pane', () => {
    expect(
      collectMovedEnvPaneKeys(
        source([
          moved,
          { ptyId: 'pty-2', paneKey: OTHER, envPaneKey: OTHER },
          { ptyId: 'pty-3', paneKey: OTHER }
        ])
      )
    ).toEqual([OLD])
  })
})
