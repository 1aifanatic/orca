import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {
  collectElectronImporters,
  collectStructuredChatEntryPoints,
  defaultEntryPoints,
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

  // Every lane that must exist; acp/ and provider-process/ may be absent until they land.
  const requiredLanes = {
    'src/main/native-chat/reader.ts': 'export {}',
    'src/main/claude/claude-session.ts': 'export {}',
    'src/main/codex/codex-session.ts': 'export {}',
    'src/main/runtime/structured-agent-session-host.ts': 'export {}',
    'src/shared/agent-session-record.ts': 'export {}'
  }

  it('covers whole lane directories, structured runtime files at any depth, and no test code', () => {
    const sources = [
      ...Object.keys(requiredLanes),
      'src/main/native-chat/nested/reader.ts',
      'src/main/native-chat/worker.mjs',
      'src/main/claude/other.ts',
      'src/main/codex/codex-provider-timeline-identity.ts',
      'src/shared/nested/agent-session-account-home.ts',
      'src/shared/relay-runtime-self-test-report.ts',
      'src/main/runtime/agent-session-record.ts',
      'src/main/runtime/structured-agent-runtime-registrations.ts',
      'src/main/runtime/rpc/methods/structured-agent-session-agents.ts',
      'src/main/acp/adapter.ts',
      'src/main/provider-process/worker.ts'
    ]
    const excluded = [
      'src/main/native-chat/reader.test.ts',
      'src/main/native-chat/reader.spec.ts',
      'src/main/native-chat/reader-test-support.ts',
      'src/main/native-chat/reader.test-support.ts',
      'src/main/native-chat/structured-agent-session-rest-test-rig.ts',
      'src/main/native-chat/structured-agent-session-host-test-data.ts',
      'src/main/native-chat/reader.test-fixture.ts',
      'src/main/native-chat/reader-fixtures.ts',
      'src/main/codex/codex-turn-lifecycle-fake.ts',
      'src/main/codex/codex-session-backfill-fs-mocks.ts',
      'src/main/native-chat/__fixtures__/reader.ts',
      'src/main/native-chat/test-support/reader.ts',
      'src/main/runtime/orca-runtime-tests/structured-agent-session-host.ts',
      'src/shared/types.d.ts',
      'src/main/runtime/other.ts',
      'src/main/runtime/rpc/methods/browser.ts'
    ]
    const root = fixture(
      Object.fromEntries([...sources, ...excluded].map((file) => [file, 'export {}']))
    )
    expect(collectStructuredChatEntryPoints(root)).toEqual(
      sources.map((file) => path.join(root, ...file.split('/'))).sort()
    )
  })

  it('fails loudly when a lane that exists today goes missing, so a rename cannot empty it', () => {
    const withoutCodex = Object.fromEntries(
      Object.entries(requiredLanes).filter(([file]) => !file.startsWith('src/main/codex/'))
    )
    expect(() => collectStructuredChatEntryPoints(fixture(withoutCodex))).toThrow(
      /src\/main\/codex is missing/
    )
    expect(collectStructuredChatEntryPoints(fixture(requiredLanes))).toHaveLength(5)
  })

  it('finds Electron through a package imported by each unwired future lane', async () => {
    const root = fixture({
      ...requiredLanes,
      'src/main/acp/adapter.ts': "import 'acp-desktop-package'",
      'src/main/provider-process/worker.ts': "import 'provider-desktop-package'",
      'node_modules/acp-desktop-package/package.json': '{"main":"index.js"}',
      'node_modules/acp-desktop-package/index.js': "require('electron')",
      'node_modules/provider-desktop-package/package.json': '{"main":"index.js"}',
      'node_modules/provider-desktop-package/index.js': "require('electron')"
    })
    const current = await collectElectronImporters(collectStructuredChatEntryPoints(root))
    expect(current.map((file) => file.split('/node_modules/').pop())).toEqual([
      'acp-desktop-package/index.js',
      'provider-desktop-package/index.js'
    ])
  })
})

describe('the default entry points', () => {
  const lanes = ['native-chat', 'claude', 'codex', 'runtime'].map((lane) => `src/main/${lane}/`)

  it('are the runtime entries plus a file from every lane that exists', () => {
    const entries = defaultEntryPoints().map((file) =>
      path.relative(process.cwd(), file).split(path.sep).join('/')
    )
    expect(entries.slice(0, 3)).toEqual([
      'src/main/runtime/orca-runtime.ts',
      'src/main/runtime/runtime-rpc.ts',
      'src/main/orcad/main.ts'
    ])
    for (const lane of [...lanes, 'src/shared/']) {
      expect(entries.some((file) => file.startsWith(lane))).toBe(true)
    }
  })

  // Why a file the runtime doesn't load: this fails if the CLI/CI default stops including the lanes.
  it('catch Electron in structured-chat code the runtime graph does not reach', async () => {
    const target = path.join(
      process.cwd(),
      'src',
      'main',
      'native-chat',
      'transcript-read-cache.ts'
    )
    const addElectron = {
      name: 'add-electron-import',
      setup(pluginBuild) {
        pluginBuild.onLoad({ filter: /transcript-read-cache\.ts$/ }, (args) =>
          args.path === target
            ? { contents: `import 'electron'\n${readFileSync(target, 'utf8')}`, loader: 'ts' }
            : undefined
        )
      }
    }
    const current = await collectElectronImporters(undefined, { plugins: [addElectron] })
    expect(current).toEqual(['src/main/native-chat/transcript-read-cache.ts'])
  }, 120_000)
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
