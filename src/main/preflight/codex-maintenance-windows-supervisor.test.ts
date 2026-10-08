import { afterEach, describe, expect, it, vi } from 'vitest'
import { codexMaintenanceWindowsSpawnSpec } from './codex-maintenance-windows-supervisor'
const { resolve } = vi.hoisted(() => ({ resolve: vi.fn() }))
vi.mock('../../shared/child-process/run-process', () => ({ resolveSpawn: resolve }))
afterEach(() => vi.clearAllMocks())
describe('Windows maintenance tree ownership', () => {
  it.each([
    {
      file: 'C:\\node\\node.exe',
      args: ['C:\\npm\\codex.js', 'update'],
      windowsVerbatimArguments: false
    },
    {
      file: 'C:\\Windows\\cmd.exe',
      args: ['/d', '/v:off', '/s', '/c', 'encoded command'],
      windowsVerbatimArguments: true
    }
  ])('retains an IPC root above the shared resolved command: $file', (resolved) => {
    resolve.mockReturnValue({
      ...resolved,
      options: {
        windowsVerbatimArguments: resolved.windowsVerbatimArguments,
        env: { PATH: 'C:\\npm', NODE_OPTIONS: '--require fake' }
      }
    })
    const input = {
      program: 'C:\\npm\\codex.cmd',
      args: ['update'],
      cwd: 'C:\\workspace',
      env: { PATH: 'C:\\npm' }
    }
    const spec = codexMaintenanceWindowsSpawnSpec(input)
    expect(resolve).toHaveBeenCalledWith(input, 'win32')
    expect(spec.program).toBe(process.execPath)
    expect(spec.stdio).toEqual(['pipe', 'pipe', 'pipe', 'ipc'])
    expect(spec.serialization).toBe('json')
    const encoded = spec.env?.ORCA_MAINTENANCE_SUPERVISOR_SPEC
    if (!encoded) {
      throw new Error('No supervisor input')
    }
    const selected = JSON.parse(Buffer.from(encoded, 'base64').toString())
    expect(selected.file).toBe(resolved.file)
    expect(selected.args).toEqual(resolved.args)
    expect(selected.cwd).toBe(input.cwd)
    expect(selected.windowsVerbatimArguments).toBe(resolved.windowsVerbatimArguments)
    expect(selected.nodeOptions).toBe('--require fake')
    expect(spec.env?.NODE_OPTIONS).toBeUndefined()
    expect(spec.env?.ELECTRON_RUN_AS_NODE).toBe('1')
  })
})
