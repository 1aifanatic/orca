import { describe, expect, it, vi } from 'vitest'
import { createClaudeCliVersionLookup } from './claude-cli-version-lookup'

function lookupWith(answers: (string | null)[], identity: () => string | null = () => 'bin\n1') {
  const probe = vi.fn(async () => answers.shift() ?? null)
  const lookup = createClaudeCliVersionLookup({ probe, identify: async () => identity() })
  return { probe, lookup }
}

describe('the Claude CLI version a launch gates on', () => {
  it('probes a binary once and answers from memory after', async () => {
    const { probe, lookup } = lookupWith(['2.1.280'])
    await expect(lookup('claude')).resolves.toBe('2.1.280')
    await expect(lookup('claude')).resolves.toBe('2.1.280')
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('never remembers a probe that did not answer', async () => {
    const { probe, lookup } = lookupWith([null, '2.1.280'])
    await expect(lookup('claude')).resolves.toBeNull()
    await expect(lookup('claude')).resolves.toBe('2.1.280')
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('probes again once the binary changes under the same command', async () => {
    let mtime = 1
    const { probe, lookup } = lookupWith(['2.1.270', '2.1.280'], () => `bin\n${mtime}`)
    await expect(lookup('claude')).resolves.toBe('2.1.270')
    mtime = 2
    await expect(lookup('claude')).resolves.toBe('2.1.280')
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('shares one probe between launches that ask at once', async () => {
    const { probe, lookup } = lookupWith(['2.1.280'])
    await expect(Promise.all([lookup('claude'), lookup('claude')])).resolves.toEqual([
      '2.1.280',
      '2.1.280'
    ])
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('answers nothing, without probing, for a command that names no file', async () => {
    const { probe, lookup } = lookupWith(['2.1.280'], () => null)
    await expect(lookup('claude')).resolves.toBeNull()
    expect(probe).not.toHaveBeenCalled()
  })
})
