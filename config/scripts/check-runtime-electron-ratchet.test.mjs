import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  collectElectronImporters,
  collectStructuredChatEntryPoints,
  diffAgainstBaseline,
  readBaseline
} from './check-runtime-electron-ratchet.mjs'

describe('structured chat coverage', () => {
  const roots = []
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function fixture(files) {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-electron-ratchet-'))
    roots.push(root)
    for (const [file, source] of Object.entries(files)) {
      const absolute = path.join(root, file)
      mkdirSync(path.dirname(absolute), { recursive: true })
      writeFileSync(absolute, source)
    }
    return root
  }

  it('covers standalone lane sources while excluding tests and allowing absent future lanes', () => {
    const sources = [
      'native-chat/nested/reader.ts',
      'native-chat/worker.mjs',
      'claude/claude-structured-session.ts',
      'claude/claude-agent-sdk-query.ts',
      'codex/codex-structured-session.ts',
      'codex/codex-app-server-connection.ts',
      'runtime/structured-agent-session-host.ts',
      'runtime/agent-session-record.ts'
    ]
    const excluded = [
      'native-chat/reader.test.ts',
      'native-chat/reader.spec.ts',
      'native-chat/reader-test-support.ts',
      'native-chat/reader.test-support.ts',
      'native-chat/reader-test-harness.ts',
      'native-chat/reader.test-fixture.ts',
      'native-chat/reader-fixture.ts',
      'native-chat/__fixtures__/reader.ts',
      'native-chat/test-support/reader.ts',
      'claude/other.ts',
      'codex/other.ts',
      'runtime/other.ts'
    ]
    const root = fixture(
      Object.fromEntries([...sources, ...excluded].map((file) => [`src/main/${file}`, 'export {}']))
    )
    expect(collectStructuredChatEntryPoints(root)).toEqual(
      sources.map((file) => path.join(root, 'src', 'main', file)).sort()
    )
  })

  it('finds Electron through a package imported by an unwired future lane', async () => {
    const root = fixture({
      'src/main/acp/adapter.ts': "import 'desktop-package'",
      'src/main/provider-process/worker.ts': 'export {}',
      'node_modules/desktop-package/package.json': '{"main":"index.js"}',
      'node_modules/desktop-package/index.js': "require('electron')"
    })
    const current = await collectElectronImporters(collectStructuredChatEntryPoints(root))
    expect(current).toHaveLength(1)
    expect(current[0].endsWith('/node_modules/desktop-package/index.js')).toBe(true)
  })
})

describe('readBaseline', () => {
  it('drops comments and blank lines and sorts, so baseline formatting cannot cause a false diff', () => {
    expect(readBaseline('# header\n\n  b/second.ts \na/first.ts\n')).toEqual([
      'a/first.ts',
      'b/second.ts'
    ])
  })
})

describe('diffAgainstBaseline', () => {
  it('reports a module that started importing electron', () => {
    expect(diffAgainstBaseline(['a.ts', 'b.ts'], ['a.ts'])).toEqual({
      added: ['b.ts'],
      removed: []
    })
  })

  it('reports a module that stopped, so the baseline is forced to tighten rather than drift', () => {
    expect(diffAgainstBaseline(['a.ts'], ['a.ts', 'b.ts'])).toEqual({
      added: [],
      removed: ['b.ts']
    })
  })

  it('is quiet when the set is unchanged', () => {
    expect(diffAgainstBaseline(['a.ts'], ['a.ts'])).toEqual({ added: [], removed: [] })
  })
})

describe('the checked-in baseline', () => {
  // Why real: the value of this gate is the transitive edges, which a fixture cannot model.
  // If this is slow enough to hurt, it is still cheaper than shipping a runtime that
  // cannot boot on Node.
  it('matches what the runtime actually reaches today', async () => {
    const current = await collectElectronImporters()
    const baseline = readBaseline(readFileSync('config/runtime-electron-baseline.txt', 'utf8'))
    expect(diffAgainstBaseline(current, baseline)).toEqual({ added: [], removed: [] })
  }, 120_000)

  // Why an exact-empty assertion now: the reachable set reached zero, so "may only
  // shrink" has no room left and any entry at all is a regression. This is strictly
  // stronger than the old under-src/ check, which only stopped a node_modules path from
  // padding a non-empty count.
  it('stays empty, so nothing reachable from the runtime imports electron', () => {
    const baseline = readBaseline(readFileSync('config/runtime-electron-baseline.txt', 'utf8'))
    expect(baseline).toEqual([])
  })
})
