import { beforeEach, describe, expect, it, vi } from 'vitest'

const { infoMock } = vi.hoisted(() => ({ infoMock: vi.fn() }))
vi.mock('sonner', () => ({ toast: { info: infoMock } }))

import { showUncheckedTerminalServicesToast } from './unchecked-terminal-services-toast'

describe('showUncheckedTerminalServicesToast', () => {
  beforeEach(() => {
    infoMock.mockReset()
  })

  it('tells the user a delete went ahead past a version that did not answer', () => {
    showUncheckedTerminalServicesToast({ uncheckedTerminalServices: [{ protocolVersion: 35 }] })

    expect(infoMock).toHaveBeenCalledWith(
      expect.stringContaining('didn’t answer'),
      expect.objectContaining({ description: expect.stringContaining('Manage Sessions') })
    )
  })

  it('stays silent for an ordinary delete', () => {
    showUncheckedTerminalServicesToast({})
    showUncheckedTerminalServicesToast(undefined)

    expect(infoMock).not.toHaveBeenCalled()
  })
})
