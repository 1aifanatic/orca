import { describe, expect, it } from 'vitest'
import {
  buildManifest,
  classifyPath,
  formatSummary,
  compileGlobs,
  isTestPath,
  parseNumstatZ,
  serializeJson
} from './pr16741-track-manifest.mjs'
import { TRACKS } from './pr16741-track-rules.mjs'

describe('compileGlobs', () => {
  it('keeps `*` inside one segment and lets `**/` span zero or more directories', () => {
    const pattern = compileGlobs(['src/**/orcad-*.ts'])
    expect(pattern.test('src/orcad-a.ts')).toBe(true)
    expect(pattern.test('src/main/ssh/orcad-a.ts')).toBe(true)
    expect(pattern.test('src/main/orcad-a/b.ts')).toBe(false)
  })

  it('expands nested brace alternatives', () => {
    const pattern = compileGlobs(['a/{B*,c-{d,e}}.ts'])
    expect(['a/Bx.ts', 'a/c-d.ts', 'a/c-e.ts'].every((path) => pattern.test(path))).toBe(true)
    expect(pattern.test('a/c-f.ts')).toBe(false)
  })

  it('treats dots and other regex characters literally', () => {
    expect(compileGlobs(['a.ts']).test('abts')).toBe(false)
  })
})

describe('classifyPath', () => {
  const cases = [
    ['src/main/daemon/pty-subprocess/bun-pty-process.ts', 'T0', 'dropped'],
    ['src/relay/relay-bun-companion-processes.integration.test.ts', 'T0', 'dropped'],
    ['src/main/sqlite/sync-database.ts', 'T0', 'dropped'],
    ['src/shared/pty-source-credit-contract.ts', 'T1', 'port'],
    ['src/shared/pty-ownership-transfer-release-gate.ts', 'T1', 'port'],
    ['src/main/runtime/rpc/ws-transport.ts', 'T1', 'port'],
    ['src/relay/relay-daemon.ts', 'T2', 'port'],
    ['src/main/ssh/ssh-connection.ts', 'T2', 'port'],
    ['src/main/ipc/ssh-reset-operation.ts', 'T3', 'port'],
    ['src/main/ssh/ssh-channel-multiplexer.ts', 'T4', 'port'],
    ['src/main/browser/remote-browser-socks-server.ts', 'T4', 'port'],
    ['src/shared/runtime-environment-store.ts', 'T5', 'port'],
    ['src/main/ssh/orcad-remote-launch.ts', 'T6', 'port'],
    ['src/main/ssh/remote-install-gc.ts', 'T6', 'port'],
    ['src/shared/pty-ownership-transfer-wire.ts', 'T7', 'deferred'],
    ['src/relay/relay-pty-raw-emission-checkpoint.ts', 'T7', 'deferred'],
    ['src/main/ssh/orcad-live-migration-start.ts', 'T8', 'deferred'],
    ['src/main/runtime/outgoing-pty-tab-removal.ts', 'T8', 'deferred'],
    ['config/reliability-gates.jsonc', 'T9', 'port']
  ]

  it.each(cases)('%s -> %s (%s)', (path, track, disposition) => {
    expect(classifyPath(path)).toMatchObject({ track, disposition })
  })

  it('gives the narrow rule precedence over the directory catch-all', () => {
    // Dormant conversion stays in the MVP even though its name also says "retirement".
    expect(
      classifyPath(
        'src/main/persistence/migrating-orcad-catalog/orcad-source-dormant-retirement.ts'
      )
    ).toMatchObject({ track: 'T6' })
    // `delivery` must not read as `live`.
    expect(classifyPath('src/main/orcad/orcad-delegated-exit-delivery.ts')).toMatchObject({
      track: 'T7'
    })
  })

  it('does not mistake `bundle` for Bun', () => {
    expect(classifyPath('src/relay/subprocess-relay-bundle.ts')).toMatchObject({ track: 'T2' })
  })

  it('records why a dropped file is dropped', () => {
    expect(classifyPath('pnpm-lock.yaml')?.reason).toMatch(/regenerated/)
  })

  it('returns null for a path no rule covers', () => {
    expect(classifyPath('src/main/unrelated/new-subsystem.ts')).toBeNull()
  })
})

describe('isTestPath', () => {
  it.each([
    'src/main/ssh/ssh-connection.test.ts',
    'src/main/runtime/orca-runtime-send-receipts.spec.ts',
    'tests/e2e/helpers/terminal.ts',
    'src/main/ssh/ssh-connection-store-test-fixture.ts',
    'src/relay/relay-live-daemon-fixture.ts',
    'src/main/ipc/ssh-ipc-module-mocks.ts',
    'config/scripts/runtime-serve-terminal-smoke.mjs'
  ])('%s is test code', (path) => {
    expect(isTestPath(path)).toBe(true)
  })

  it.each(['src/main/ssh/ssh-connection.ts', 'src/main/ssh/orcad-remote-context.ts'])(
    '%s is production code',
    (path) => {
      expect(isTestPath(path)).toBe(false)
    }
  )
})

describe('parseNumstatZ', () => {
  it('reads plain, binary and renamed records', () => {
    const output = ['3\t1\ta.ts', '-\t-\timg.patch', '8\t8\t', 'old.ts', 'new.ts', ''].join('\0')
    expect(parseNumstatZ(output)).toEqual([
      { path: 'a.ts', added: 3, deleted: 1, binary: false },
      { path: 'img.patch', added: 0, deleted: 0, binary: true },
      { path: 'new.ts', previousPath: 'old.ts', added: 8, deleted: 8, binary: false }
    ])
  })

  it('rejects a malformed record instead of dropping it', () => {
    expect(() => parseNumstatZ('x\ty\tz.ts\0')).toThrow(/Unparseable/)
  })
})

describe('buildManifest', () => {
  const entries = [
    { path: 'src/main/ssh/ssh-connection.ts', added: 10, deleted: 2, binary: false },
    { path: 'src/main/ssh/ssh-connection.test.ts', added: 5, deleted: 0, binary: false },
    { path: 'src/main/sqlite/sync-database.ts', added: 7, deleted: 0, binary: false },
    { path: 'src/main/ssh/orcad-remote-deploy.ts', added: 4, deleted: 0, binary: false },
    { path: 'src/main/unrelated/new-subsystem.ts', added: 1, deleted: 0, binary: false }
  ]

  it('reports unassigned files and splits prod from test lines per track', () => {
    const manifest = buildManifest(entries)
    expect(manifest.unassigned).toEqual(['src/main/unrelated/new-subsystem.ts'])
    expect(manifest.tracks.T2).toMatchObject({
      files: 2,
      prodAdded: 10,
      prodDeleted: 2,
      testAdded: 5
    })
    expect(manifest.files['src/main/sqlite/sync-database.ts']).toEqual([
      'T0',
      'dropped',
      'prod',
      7,
      0
    ])
    expect(Object.keys(manifest.tracks)).toEqual(Object.keys(TRACKS))
  })

  it('marks a ported path where main diverged as reconcile, but never un-drops one', () => {
    const mainDivergence = new Map([
      ['src/main/ssh/orcad-remote-deploy.ts', 'main has since added its own copy'],
      ['src/main/sqlite/sync-database.ts', 'main has since added its own copy']
    ])
    const manifest = buildManifest(entries, { mainDivergence })
    expect(manifest.files['src/main/ssh/orcad-remote-deploy.ts'][1]).toBe('reconcile')
    expect(manifest.notes['src/main/ssh/orcad-remote-deploy.ts']).toMatch(/own copy/)
    expect(manifest.files['src/main/sqlite/sync-database.ts'][1]).toBe('dropped')
  })
})

describe('serializeJson', () => {
  it('keeps short arrays inline and breaks ones past the print width', () => {
    const long = 'x'.repeat(90)
    const text = serializeJson({ files: { a: ['T2', 1], [long]: ['T7', 'deferred'] } })
    expect(text).toContain('"a": ["T2", 1],')
    expect(text).toContain(`"${long}": [\n      "T7",\n      "deferred"\n    ]`)
    expect(JSON.parse(text)).toEqual({ files: { a: ['T2', 1], [long]: ['T7', 'deferred'] } })
  })
})

describe('formatSummary', () => {
  it('prints one aligned row per track with no trailing spaces', () => {
    const { tracks } = buildManifest([
      { path: 'src/main/ssh/ssh-connection.ts', added: 10, deleted: 2, binary: false }
    ])
    const lines = formatSummary(tracks).split('\n')
    expect(lines).toHaveLength(Object.keys(TRACKS).length + 1)
    expect(lines.find((line) => line.startsWith('T2'))).toMatch(
      /^T2\s+port\s+1\s+10\/2\s+0\/0\s+SSH core/
    )
    expect(lines.every((line) => line === line.trimEnd())).toBe(true)
  })
})
