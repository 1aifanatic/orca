import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import { join } from 'node:path'
import { parse } from 'smol-toml'

// Why: temp homes exceed sun_path on macOS but not on Linux; keep asserted config bytes host-independent.
vi.mock('./codex-daemon-socket-path-guard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  applyCodexDaemonSocketGuard: (config: string) => config
}))

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return {
    ...actual,
    homedir: homedirMock
  }
})

import {
  syncManagedCodexHomeWithoutSourceConfig,
  syncSystemConfigIntoLegacySharedCodexHome,
  syncSystemConfigIntoManagedCodexHome
} from './codex-config-mirror'

let fakeHomeDir: string
let userDataDir: string
let previousUserDataPath: string | undefined

function getSystemCodexHomePath(): string {
  return join(fakeHomeDir, '.codex')
}

function getSystemConfigPath(): string {
  return join(getSystemCodexHomePath(), 'config.toml')
}

function getRuntimeConfigPath(): string {
  return join(userDataDir, 'codex-runtime-home', 'home', 'config.toml')
}

beforeEach(() => {
  fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-codex-config-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-codex-config-user-data-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(fakeHomeDir)
  getPathMock.mockImplementation((name: string) => {
    if (name === 'userData') {
      return userDataDir
    }
    throw new Error(`unexpected app.getPath(${name})`)
  })
  mkdirSync(getSystemCodexHomePath(), { recursive: true })
})

afterEach(() => {
  rmSync(fakeHomeDir, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  vi.clearAllMocks()
})

describe('managed-home mirror never writes a config Codex cannot read (#22592)', () => {
  it('collapses both project spellings and a doubled [hooks.state] in an existing managed home (#22592)', () => {
    writeFileSync(
      getSystemConfigPath(),
      'model = "m"\n\n["projects"."/repo"]\ntrust_level = "trusted"\n',
      'utf-8'
    )
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    writeFileSync(
      getRuntimeConfigPath(),
      [
        'model = "m"',
        '',
        '["projects"."/repo"]',
        'trust_level = "trusted"',
        '',
        '[projects."/repo"]',
        'trust_level = "trusted"',
        '',
        '[hooks.state]',
        '',
        '[hooks.state]',
        '',
        '[hooks.state."/rt/hooks.json:stop:0:0"]',
        'enabled = true',
        'trusted_hash = "sha256:x"',
        ''
      ].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(parse(runtimeConfig)).toEqual({
      model: 'm',
      projects: { '/repo': { trust_level: 'trusted' } },
      hooks: { state: { '/rt/hooks.json:stop:0:0': { enabled: true, trusted_hash: 'sha256:x' } } }
    })
  })

  it('drops a runtime project table that ~/.codex defines inline', () => {
    writeFileSync(
      getSystemConfigPath(),
      '[projects]\n"/repo" = { trust_level = "untrusted" }\n',
      'utf-8'
    )
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    writeFileSync(getRuntimeConfigPath(), '[projects."/repo"]\ntrust_level = "trusted"\n', 'utf-8')

    syncSystemConfigIntoManagedCodexHome()

    expect(parse(readFileSync(getRuntimeConfigPath(), 'utf-8'))).toEqual({
      projects: { '/repo': { trust_level: 'untrusted' } }
    })
  })

  it('copies an unparseable ~/.codex verbatim so Orca-launched Codex fails like hand-typed codex', () => {
    const broken = '[mcp_servers.a]\ncommand = "x"\n[mcp_servers.a]\ncommand = "y"\n'
    writeFileSync(getSystemConfigPath(), broken, 'utf-8')
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    writeFileSync(getRuntimeConfigPath(), 'model = "stale"\n[a\n', 'utf-8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    syncSystemConfigIntoManagedCodexHome()
    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(getRuntimeConfigPath(), 'utf-8')).toBe(
      `${broken}${verbatimMarker(getSystemConfigPath())}`
    )
    const copies = warn.mock.calls
      .flat()
      .filter((line) => String(line).includes('copied it unchanged'))
    expect(copies).toHaveLength(1)
    warn.mockRestore()
  })

  it('collapses Orca\u2019s own duplicate hook tables instead of reseeding, so managed-only trust survives', () => {
    writeFileSync(getSystemConfigPath(), 'model = "m"\n', 'utf-8')
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    const key = '/rt/hooks.json:stop:0:0'
    writeFileSync(
      getRuntimeConfigPath(),
      [
        'model = "m"',
        '',
        '[projects."/answered-in-orca"]',
        'trust_level = "trusted"',
        '',
        `[hooks.state."${key}"]`,
        'trusted_hash = "sha256:a"',
        '',
        `[hooks.state."${key}"]`,
        'trusted_hash = "sha256:b"',
        ''
      ].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    expect(parse(readFileSync(getRuntimeConfigPath(), 'utf-8'))).toEqual({
      model: 'm',
      projects: { '/answered-in-orca': { trust_level: 'trusted' } },
      hooks: { state: { [key]: { trusted_hash: 'sha256:a' } } }
    })
    expect(existsSync(`${getRuntimeConfigPath()}.bak`)).toBe(false)
  })

  it('keeps a discarded unparseable managed config as .bak when it differs from ~/.codex', () => {
    writeFileSync(getSystemConfigPath(), 'model = "A"\n', 'utf-8')
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    const discarded = 'model = "mine"\n[a\n'
    writeFileSync(getRuntimeConfigPath(), discarded, 'utf-8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(getRuntimeConfigPath(), 'utf-8')).toBe('model = "A"\n')
    expect(readFileSync(`${getRuntimeConfigPath()}.bak`, 'utf-8')).toBe(discarded)
    expect(warn.mock.calls.flat().join(' ')).toContain('.bak')
    warn.mockRestore()
  })

  it('keeps no .bak when the managed config it replaces still parses', () => {
    writeFileSync(getSystemConfigPath(), 'model = "B"\n', 'utf-8')
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    writeFileSync(getRuntimeConfigPath(), 'model = "A"\n', 'utf-8')

    syncSystemConfigIntoManagedCodexHome()

    expect(existsSync(`${getRuntimeConfigPath()}.bak`)).toBe(false)
  })

  it('leaves a managed config that parses untouched while ~/.codex is broken, and logs why once', () => {
    writeFileSync(getSystemConfigPath(), 'model = "A"\nbroken = \n', 'utf-8')
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    writeFileSync(getRuntimeConfigPath(), 'model = "A"\n', 'utf-8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    syncSystemConfigIntoManagedCodexHome()
    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(getRuntimeConfigPath(), 'utf-8')).toBe('model = "A"\n')
    expect(warn.mock.calls.flat().filter((line) => String(line).includes('left '))).toHaveLength(1)
    warn.mockRestore()
  })

  it('seeds a fresh managed home with the same verbatim copy', () => {
    writeFileSync(getSystemConfigPath(), 'log_dir = "logs\\uD800dir"\n', 'utf-8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(getRuntimeConfigPath(), 'utf-8')).toBe(
      `log_dir = "logs\\uD800dir"\n${verbatimMarker(getSystemConfigPath())}`
    )
    warn.mockRestore()
  })
})

// Why: an invalid save of ~/.codex followed by a fix must end exactly where the
// same edits without the invalid save end; nothing managed-only may be lost and
// nothing stale may be promoted into ~/.codex.
function verbatimMarker(sourcePath: string): string {
  return `# orca: verbatim copy of ${sourcePath}; replaced when the source parses\n`
}

describe('break-then-fix of ~/.codex keeps managed-home state', () => {
  function makeHomes(): {
    homes: { systemHomePath: string; runtimeHomePath: string }
    root: string
  } {
    const root = mkdtempSync(join(tmpdir(), 'orca-break-fix-'))
    const homes = { systemHomePath: join(root, 'sys'), runtimeHomePath: join(root, 'rt') }
    mkdirSync(homes.systemHomePath, { recursive: true })
    mkdirSync(homes.runtimeHomePath, { recursive: true })
    return { homes, root }
  }

  function runInCodexChangesThenFix(breakFirst: boolean): { system: string; runtime: string } {
    const { homes, root } = makeHomes()
    const sysPath = join(homes.systemHomePath, 'config.toml')
    const rtPath = join(homes.runtimeHomePath, 'config.toml')
    const good = 'model = "A"\n\n[mcp_servers.keep]\ncommand = "k"\n'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      writeFileSync(sysPath, good)
      syncSystemConfigIntoManagedCodexHome(homes)
      // Codex inside Orca: /model B, an MCP server added there, a trust answer.
      writeFileSync(
        rtPath,
        `${readFileSync(rtPath, 'utf8').replace('model = "A"', 'model = "B"')}\n[mcp_servers.mine]\ncommand = "m"\n\n[projects."/sub"]\ntrust_level = "trusted"\n`
      )
      if (breakFirst) {
        writeFileSync(sysPath, `${good}broken = \n`)
        syncSystemConfigIntoManagedCodexHome(homes)
      }
      writeFileSync(sysPath, good)
      syncSystemConfigIntoManagedCodexHome(homes)
      syncSystemConfigIntoManagedCodexHome(homes)
      return { system: readFileSync(sysPath, 'utf8'), runtime: readFileSync(rtPath, 'utf8') }
    } finally {
      warn.mockRestore()
      rmSync(root, { recursive: true, force: true })
    }
  }

  it('ends where the same edits without the invalid save end', () => {
    const withBreak = runInCodexChangesThenFix(true)
    expect(withBreak).toEqual(runInCodexChangesThenFix(false))
    expect(withBreak.runtime).toContain('[mcp_servers.mine]')
    expect(withBreak.runtime).toContain('[projects."/sub"]')
  })

  it('never promotes a value from the broken save into ~/.codex', () => {
    const { homes, root } = makeHomes()
    const sysPath = join(homes.systemHomePath, 'config.toml')
    const rtPath = join(homes.runtimeHomePath, 'config.toml')
    const good =
      'model = "A"\nsandbox_mode = "workspace-write"\n\n[mcp_servers.keep]\ncommand = "k"\n'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      writeFileSync(sysPath, good)
      syncSystemConfigIntoManagedCodexHome(homes)
      writeFileSync(
        rtPath,
        `${readFileSync(rtPath, 'utf8')}\n[projects."/w"]\ntrust_level = "trusted"\n`
      )
      syncSystemConfigIntoManagedCodexHome(homes)
      writeFileSync(
        sysPath,
        'model = "A"\nsandbox_mode = "danger-full-access"\nbroken = \n\n[mcp_servers.keep]\ncommand = "k"\n\n[mcp_servers.tmp]\ncommand = "t"\n'
      )
      syncSystemConfigIntoManagedCodexHome(homes)
      writeFileSync(sysPath, good)
      syncSystemConfigIntoManagedCodexHome(homes)
      syncSystemConfigIntoManagedCodexHome(homes)

      expect(readFileSync(sysPath, 'utf8')).toBe(good)
      const runtime = readFileSync(rtPath, 'utf8')
      expect(runtime).toContain('sandbox_mode = "workspace-write"')
      expect(runtime).toContain('[projects."/w"]')
      expect(runtime).not.toContain('mcp_servers.tmp')
      expect(runtime).not.toContain('danger-full-access')
    } finally {
      warn.mockRestore()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('never treats a verbatim copy as managed state, even when the mirror dedupe would make it parse', () => {
    const { homes, root } = makeHomes()
    const sysPath = join(homes.systemHomePath, 'config.toml')
    const rtPath = join(homes.runtimeHomePath, 'config.toml')
    const good = 'model = "A"\n\n[mcp_servers.keep]\ncommand = "k"\n'
    // Why: broken only by a duplicate project table that Orca's repair must not collapse.
    const broken =
      'model = "A"\n\n[marketplaces.stale]\nsource = "s"\n\n[mcp_servers.tmp]\ncommand = "t"\n\n[projects."/x"]\ntrust_level = "trusted"\nfoo = 1\n\n[projects."/x"]\nbar = 2\n'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      writeFileSync(sysPath, broken)
      syncSystemConfigIntoManagedCodexHome(homes)
      expect(readFileSync(rtPath, 'utf8')).toBe(`${broken}${verbatimMarker(sysPath)}`)
      syncSystemConfigIntoManagedCodexHome(homes)
      // The user fixes ~/.codex and removes the stale marketplace, the server and the project.
      writeFileSync(sysPath, good)
      syncSystemConfigIntoManagedCodexHome(homes)
      syncSystemConfigIntoManagedCodexHome(homes)

      expect(readFileSync(sysPath, 'utf8')).toBe(good)
      const runtime = readFileSync(rtPath, 'utf8')
      expect(runtime).not.toContain('marketplaces.stale')
      expect(runtime).not.toContain('mcp_servers.tmp')
      expect(runtime).not.toContain('projects."/x"')
      expect(runtime).not.toContain('orca: verbatim copy')
    } finally {
      warn.mockRestore()
      rmSync(root, { recursive: true, force: true })
    }
  })

  describe('the verbatim copy is replaced once the user deletes or empties ~/.codex/config.toml', () => {
    const broken = 'model = "A"\nbroken = \n'
    const good = 'model = "C"\n'

    it.each([
      [
        'deleted, managed mirror',
        (sysPath: string) => rmSync(sysPath),
        syncSystemConfigIntoManagedCodexHome
      ],
      [
        'emptied, managed mirror',
        (sysPath: string) => writeFileSync(sysPath, ''),
        syncSystemConfigIntoManagedCodexHome
      ],
      [
        'deleted, account home without a source',
        (sysPath: string) => rmSync(sysPath),
        syncManagedCodexHomeWithoutSourceConfig
      ],
      [
        'deleted, legacy shared home',
        (sysPath: string) => rmSync(sysPath),
        syncSystemConfigIntoLegacySharedCodexHome
      ]
    ])('%s', (_label, clearSource, syncWithoutSource) => {
      const { homes, root } = makeHomes()
      const sysPath = join(homes.systemHomePath, 'config.toml')
      const rtPath = join(homes.runtimeHomePath, 'config.toml')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        writeFileSync(sysPath, broken)
        syncSystemConfigIntoManagedCodexHome(homes)
        expect(readFileSync(rtPath, 'utf8')).toBe(`${broken}${verbatimMarker(sysPath)}`)

        clearSource(sysPath)
        syncWithoutSource(homes)
        expect(readFileSync(rtPath, 'utf8')).toBe('')

        writeFileSync(sysPath, good)
        syncSystemConfigIntoManagedCodexHome(homes)
        expect(readFileSync(sysPath, 'utf8')).toBe(good)
        expect(readFileSync(rtPath, 'utf8')).toBe(good)
      } finally {
        warn.mockRestore()
        rmSync(root, { recursive: true, force: true })
      }
    })
  })

  it('treats a valid ~/.codex that ends in the marker text as the user config, not a copy', () => {
    const { homes, root } = makeHomes()
    const sysPath = join(homes.systemHomePath, 'config.toml')
    const rtPath = join(homes.runtimeHomePath, 'config.toml')
    const markerLine = '# orca: verbatim copy of /x/config.toml; replaced when the source parses\n'
    try {
      writeFileSync(sysPath, `model = "A"\n${markerLine}`)
      syncSystemConfigIntoManagedCodexHome(homes)
      // Codex inside Orca: /model B.
      writeFileSync(rtPath, readFileSync(rtPath, 'utf8').replace('model = "A"', 'model = "B"'))
      syncSystemConfigIntoManagedCodexHome(homes)

      expect(parse(readFileSync(sysPath, 'utf8')).model).toBe('B')
      expect(parse(readFileSync(rtPath, 'utf8')).model).toBe('B')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps a broken managed config as .bak before the verbatim copy replaces it, and never backs up the copy', () => {
    const { homes, root } = makeHomes()
    const sysPath = join(homes.systemHomePath, 'config.toml')
    const rtPath = join(homes.runtimeHomePath, 'config.toml')
    const good = 'model = "A"\n'
    const brokenManaged = 'model = "A"\n\n[mcp_servers.mine]\ncommand = "m"\n\nx = = 1\n'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      writeFileSync(sysPath, `${good}broken = \n`)
      writeFileSync(rtPath, brokenManaged)
      syncSystemConfigIntoManagedCodexHome(homes)
      expect(readFileSync(rtPath, 'utf8')).toContain('orca: verbatim copy')
      expect(readFileSync(`${rtPath}.bak`, 'utf8')).toBe(brokenManaged)

      writeFileSync(sysPath, good)
      syncSystemConfigIntoManagedCodexHome(homes)
      expect(readFileSync(rtPath, 'utf8')).toBe(good)
      expect(readFileSync(`${rtPath}.bak`, 'utf8')).toBe(brokenManaged)
    } finally {
      warn.mockRestore()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
