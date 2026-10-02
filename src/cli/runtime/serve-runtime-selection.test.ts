import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NODE_RUNTIME_ASSETS } from '../../shared/node-runtime-pin'
import {
  ORCAD_NODE_RUNTIME_MARKER_FILENAME,
  ORCAD_SERVER_TARGET_FILENAME,
  ORCAD_VERSION_FILENAME,
  orcadNodeRuntimeRelativePath
} from '../../shared/orcad-artifacts'
import { formatOrcadNativePreflightReport } from '../../shared/orcad-native-preflight-report'
import { orcadServeArgs } from './serve-orcad-launch'
import {
  selectServeRuntime,
  SERVE_RUNTIME_ENV,
  type ServeRuntimeSelectionInput
} from './serve-runtime-selection'

const TARGET = 'linux-x64-glibc'
const SHA = NODE_RUNTIME_ASSETS[TARGET].executableSha256
let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-serve-runtime-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A materialized slot as the template would leave it: no runtime of its own yet. */
function slotFixture(): string {
  const slot = join(root, 'orcad-artifacts', TARGET, '0.1.0+abc')
  mkdirSync(slot, { recursive: true })
  writeFileSync(join(slot, ORCAD_SERVER_TARGET_FILENAME), `${TARGET}\n`)
  writeFileSync(join(slot, ORCAD_NODE_RUNTIME_MARKER_FILENAME), `${SHA}\n`)
  writeFileSync(join(slot, ORCAD_VERSION_FILENAME), '0.1.0+abc\n')
  writeFileSync(join(slot, 'orcad.js'), '')
  return slot
}

function input(overrides: Partial<ServeRuntimeSelectionInput> = {}): ServeRuntimeSelectionInput {
  const template = join(root, 'orcad-template')
  mkdirSync(template, { recursive: true })
  const cachedNode = join(root, 'cached-node')
  writeFileSync(cachedNode, '#!/bin/sh\n')
  return {
    env: { [SERVE_RUNTIME_ENV]: 'orcad' },
    platform: 'linux',
    userDataPath: root,
    templateDirs: [join(root, 'missing-template'), template],
    usesMacUpdateHandoff: false,
    hostTarget: () => TARGET,
    materializeSlot: vi.fn(async () => slotFixture()),
    materializeRuntime: vi.fn(async () => cachedNode),
    nativePreflight: async () => `${formatOrcadNativePreflightReport('ok', null)}\n`,
    ...overrides
  }
}

describe('orca serve runtime selection', () => {
  it('stays on Electron, silently, unless orcad is asked for', async () => {
    expect(await selectServeRuntime(input({ env: {} }))).toEqual({
      kind: 'electron',
      reason: null
    })
  })

  it('runs the local slot on its pinned Node, linked into userData beside it', async () => {
    const options = input()
    const selection = await selectServeRuntime(options)
    const slot = join(root, 'orcad-artifacts', TARGET, '0.1.0+abc')
    const runtime = join(slot, ...orcadNodeRuntimeRelativePath(TARGET, SHA))
    expect(selection).toEqual({
      kind: 'orcad',
      runtime,
      entry: join(slot, 'orcad.js'),
      version: '0.1.0+abc'
    })
    expect(existsSync(runtime)).toBe(true)
    expect(runtime.startsWith(join(root, 'orcad-artifacts'))).toBe(true)
    expect(options.materializeSlot).toHaveBeenCalledWith(TARGET, {
      templateDir: join(root, 'orcad-template'),
      cacheRoot: join(root, 'orcad-artifacts')
    })
  })

  it.each([
    ['Windows', { platform: 'win32' as const }, 'local orcad on Windows is not enabled'],
    ['packaged macOS', { usesMacUpdateHandoff: true }, 'no macOS app-update handoff'],
    ['an unsupported host', { hostTarget: () => 'linux-riscv64-glibc' }, 'no orcad build exists'],
    ['an install without the template', { templateDirs: [] }, 'carries no orcad template'],
    [
      'an offline first run',
      {
        materializeRuntime: vi.fn(async (): Promise<string> => {
          throw new Error('fetch failed')
        })
      },
      'could not be prepared: fetch failed'
    ],
    [
      'a host whose node-pty cannot load',
      {
        nativePreflight: async () => formatOrcadNativePreflightReport('blocked', 'load_crashed')
      },
      'cannot run terminals here (blocked: load_crashed)'
    ],
    [
      'a silent preflight',
      { nativePreflight: async () => '' },
      'did not answer its native preflight'
    ]
  ])('falls back to Electron on %s and says why', async (_name, overrides, reason) => {
    const selection = await selectServeRuntime(input(overrides))
    expect(selection).toEqual({ kind: 'electron', reason: expect.stringContaining(reason) })
  })

  it('forwards every desktop serve flag, binding wide as Electron serve does', () => {
    expect(
      orcadServeArgs({
        json: true,
        port: '6768',
        pairingAddress: '10.0.0.5',
        noPairing: true,
        mobilePairing: true,
        recipeJson: true,
        projectRoot: '/work/app'
      })
    ).toEqual([
      '--bind',
      '0.0.0.0',
      '--json',
      '--port',
      '6768',
      '--pairing-address',
      '10.0.0.5',
      '--no-pairing',
      '--mobile-pairing',
      '--recipe-json',
      '--project-root',
      '/work/app'
    ])
    expect(orcadServeArgs({})).toEqual(['--bind', '0.0.0.0'])
  })
})
