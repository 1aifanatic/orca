import { beforeEach, describe, expect, it, vi } from 'vitest'

const { infoMock, openManageSessionsMock } = vi.hoisted(() => ({
  infoMock: vi.fn(),
  openManageSessionsMock: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { info: infoMock } }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('../settings/open-manage-sessions', () => ({ openManageSessions: openManageSessionsMock }))

import { showUncheckedTerminalServicesToast } from './unchecked-terminal-services-toast'

const unchecked = { uncheckedTerminalServices: [{ protocolVersion: 35 }] }

describe('showUncheckedTerminalServicesToast', () => {
  beforeEach(() => {
    infoMock.mockReset()
    openManageSessionsMock.mockReset()
  })

  it('offers to open Manage Sessions for a delete on this machine, under one toast id', () => {
    showUncheckedTerminalServicesToast(unchecked, { onThisMachine: true })
    showUncheckedTerminalServicesToast(unchecked, { onThisMachine: true })

    expect(infoMock).toHaveBeenCalledTimes(2)
    const [title, options] = infoMock.mock.calls[0]!
    expect(title).toContain('didn’t answer')
    expect(title).not.toContain('older')
    expect(options.id).toBe(infoMock.mock.calls[1]![1].id)
    options.action.onClick()
    expect(openManageSessionsMock).toHaveBeenCalledOnce()
  })

  it('does not point a paired host’s delete at this machine’s Manage Sessions', () => {
    showUncheckedTerminalServicesToast(unchecked, { onThisMachine: false })

    const [, options] = infoMock.mock.calls[0]!
    expect(options.action).toBeUndefined()
    expect(options.description).not.toContain('Manage Sessions')
  })

  it('stays silent for an ordinary delete', () => {
    showUncheckedTerminalServicesToast({}, { onThisMachine: true })
    showUncheckedTerminalServicesToast(undefined, { onThisMachine: true })

    expect(infoMock).not.toHaveBeenCalled()
  })
})
