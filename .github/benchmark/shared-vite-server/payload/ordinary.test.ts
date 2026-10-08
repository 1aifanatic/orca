import { expect, it, vi } from 'vitest'
import { sourceValue, mutableState } from './source-value'
import { locationValue } from './relocation'
import { configValue } from 'probe-config-choice'

declare const ORCA_CACHE_PROBE_DEFINE: string
const role = 'bun'
const coordinator = process.env.ORCA_CACHE_PROBE_COORDINATOR
const expectsBun = coordinator === 'bun' && role === 'bun'

vi.mock('./mock-target', () => ({
  mockedValue: `factory-a:${process.env.ORCA_CACHE_PROBE_FACTORY_ENV}`
}))
import { mockedValue } from './mock-target'

it('uses the required actual runtime', () => {
  expect(Boolean(process.versions.bun)).toBe(expectsBun)
  expect(process.env.ORCA_VITEST_RUNTIME).toBe(
    expectsBun ? 'bun' : coordinator === 'bun' ? 'node-runtime' : 'node'
  )
  if (!expectsBun) {
    expect(process.release.name).toBe('node')
    expect(Number(process.versions.node.split('.')[0])).toBeGreaterThanOrEqual(24)
  }
})
it('loads the current imported source', () => {
  expect(sourceValue).toBe(process.env.ORCA_CACHE_PROBE_SOURCE)
})
it('loads the current config define', () => {
  expect(ORCA_CACHE_PROBE_DEFINE).toBe(process.env.ORCA_CACHE_PROBE_DEFINE)
})
it('resolves the current config alias', () => {
  expect(configValue).toBe(process.env.ORCA_CACHE_PROBE_CONFIG_VALUE)
})
it('evaluates the current mock factory and environment', () => {
  expect(mockedValue).toBe(process.env.ORCA_CACHE_PROBE_MOCK)
})
it('resolves the current dependency location', () => {
  expect(locationValue).toBe(process.env.ORCA_CACHE_PROBE_LOCATION)
})
it('retains fresh mutable exports between isolated files', () => {
  expect(mutableState).toEqual([])
  mutableState.push(role)
})

it('resets imported mutable module state without sharing the prior instance', async () => {
  const prior = await import('./reset-state')
  expect(prior.resetState).toEqual([])
  prior.resetState.push(role)
  vi.resetModules()
  const fresh = await import('./reset-state')
  expect(fresh.resetState).toEqual([])
  expect(fresh.resetState).not.toBe(prior.resetState)
  expect(prior.resetState).toEqual([role])
  expect(mockedValue).toBe(process.env.ORCA_CACHE_PROBE_MOCK)
})
it('honors dynamic mocks and unmocking while preserving an existing imported binding', async () => {
  try {
    vi.doMock('./mock-target', () => ({ mockedValue: 'dynamic-owned' }))
    vi.resetModules()
    expect((await import('./mock-target')).mockedValue).toBe('dynamic-owned')
    vi.doUnmock('./mock-target')
    vi.resetModules()
    expect((await import('./mock-target')).mockedValue).toBe('real-target')
    expect(mockedValue).toBe(process.env.ORCA_CACHE_PROBE_MOCK)
  } finally {
    vi.doUnmock('./mock-target')
    vi.resetModules()
  }
})
