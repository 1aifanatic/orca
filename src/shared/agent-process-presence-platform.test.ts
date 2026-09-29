import { afterEach, describe, expect, it, vi } from 'vitest'
import { readAgentProcess } from './agent-process-presence-probe'

const nativeRead = vi.hoisted(() => vi.fn())
const run = vi.hoisted(() => vi.fn())
const read = vi.hoisted(() => vi.fn())
vi.mock('../main/windows/windows-process-table', () => ({
  readWindowsProcessCreationTime: nativeRead
}))
vi.mock('./child-process/run-process', () => ({ runProcess: run }))
vi.mock('node:fs/promises', () => ({ readFile: read }))
const hostProcess = process
function platform(name: string): void {
  vi.stubGlobal('process', { ...hostProcess, platform: name })
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})

describe('platform process evidence', () => {
  it('never turns Windows native null or unavailable capability into exit', async () => {
    platform('win32')
    nativeRead.mockReturnValue(null)
    expect(await readAgentProcess(4242)).toEqual({ verdict: 'unverifiable' })
    nativeRead.mockImplementation(() => {
      throw new Error('missing addon')
    })
    expect(await readAgentProcess(4242)).toEqual({ verdict: 'unverifiable' })
    nativeRead.mockReturnValue(100)
    expect(await readAgentProcess(4242)).toEqual({
      verdict: 'live',
      startTime: '100',
      zombie: false
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('treats a missing macOS utility as unanswered', async () => {
    platform('darwin')
    run.mockRejectedValue(Object.assign(new Error('missing ps'), { code: 'ENOENT' }))
    expect(await readAgentProcess(4242)).toEqual({ verdict: 'unverifiable' })
  })

  it('requires Linux process-file absence rather than an unreadable boot identity', async () => {
    platform('linux')
    read.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENOENT' }))
    expect(await readAgentProcess(4242)).toEqual({ verdict: 'exited' })
    const fields = ['S', ...Array(18).fill('0'), '100']
    read
      .mockResolvedValueOnce(`4242 (agent (name)) ${fields.join(' ')}`)
      .mockRejectedValueOnce(new Error('permission denied'))
    expect(await readAgentProcess(4242)).toEqual({ verdict: 'unverifiable' })
    read
      .mockResolvedValueOnce(`4242 (agent (name)) ${fields.join(' ')}`)
      .mockResolvedValueOnce('boot-id\n')
    expect(await readAgentProcess(4242)).toEqual({
      verdict: 'live',
      startTime: 'boot-id:100',
      zombie: false
    })
  })
})
