import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WRITE_ACCEPTED,
  writeRefused,
  writeUnverifiable,
  type WriteSettlement
} from '../../../../shared/pty-write-settlement'
import { TERMINAL_INPUT_CHUNK_MAX_BYTES } from '../../../../shared/terminal-input'
import { ptyOwnership } from '../provider/ownership-state'
import { createPtyWriteInput } from './write-input'

const { provider } = vi.hoisted(() => ({
  provider: {
    hasPty: vi.fn(() => true),
    write: vi.fn(),
    writeWithSettlement:
      vi.fn<(id: string, data: string) => WriteSettlement | Promise<WriteSettlement>>()
  }
}))
vi.mock('../provider/registry', () => ({ tryGetProviderForPty: () => provider }))

const id = 'pty-acceptance'
const write = (data: string) =>
  createPtyWriteInput({}).writePtyInputAccepted({ id, data, inputKind: 'driving' })

beforeEach(() => {
  vi.clearAllMocks()
  provider.hasPty.mockReturnValue(true)
  provider.writeWithSettlement.mockReturnValue(WRITE_ACCEPTED)
})
afterEach(() => {
  ptyOwnership.delete(id)
})

describe('verified renderer writes reuse provider settlement', () => {
  it.each(['local', 'daemon', 'WSL', 'SSH'])(
    'waits for %s acceptance without a raw duplicate',
    async (host) => {
      ptyOwnership.set(id, host === 'SSH' ? 'connection-1' : null)
      let finish: (settlement: WriteSettlement) => void = () => {}
      provider.writeWithSettlement.mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve
        })
      )
      let completed = false
      const pending = Promise.resolve(write('\x1b')).then((accepted) => {
        completed = true
        return accepted
      })
      await Promise.resolve()
      expect(completed).toBe(false)
      expect(provider.writeWithSettlement).toHaveBeenCalledExactlyOnceWith(id, '\x1b')
      finish(WRITE_ACCEPTED)
      await expect(pending).resolves.toBe(true)
      expect(provider.write).not.toHaveBeenCalled()
    }
  )

  it('reports proven refusal and unknown acknowledgment separately', async () => {
    ptyOwnership.set(id, 'connection-1')
    provider.writeWithSettlement.mockReturnValueOnce(writeRefused('endpoint_disconnected'))
    expect(write('1')).toBe(false)
    provider.writeWithSettlement.mockResolvedValueOnce(
      writeUnverifiable('transport_settlement_lost', true)
    )
    await expect(write('1')).rejects.toThrow('acknowledgment unavailable')
    expect(provider.write).not.toHaveBeenCalled()
  })

  it('never sends an unowned or absent PTY', () => {
    expect(write('1')).toBe(false)
    ptyOwnership.set(id, null)
    provider.hasPty.mockReturnValue(false)
    expect(write('1')).toBe(false)
    expect(provider.writeWithSettlement).not.toHaveBeenCalled()
  })

  it('waits for each chunk and stops a paste after refusal', async () => {
    ptyOwnership.set(id, 'connection-1')
    provider.writeWithSettlement
      .mockReturnValueOnce(WRITE_ACCEPTED)
      .mockReturnValueOnce(writeRefused('transport_queue_full'))
    await expect(write('x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES * 2 + 1))).resolves.toBe(false)
    expect(provider.writeWithSettlement).toHaveBeenCalledTimes(2)
    expect(provider.write).not.toHaveBeenCalled()
  })
})
