import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { importReleaseCheckoutModule, type ReleaseCheckout } from './release-checkout'
import {
  collectDroppedImports,
  droppedReleasePackages,
  installDroppedDependencyStandIns,
  type DroppedImports
} from './release-dropped-dependencies'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function syntheticRelease(files: Record<string, string>): ReleaseCheckout {
  // Why realpath: vite reports module urls through macOS's /var -> /private/var symlink.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-cross-version-dropped-')))
  temporaryRoots.push(root)
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), source)
  }
  return { ref: 'v0.0.0-synthetic', commit: 'f'.repeat(40), label: 'v0.0.0-synthetic', root }
}

const dropped = droppedReleasePackages(
  {
    dependencies: { 'dropped-parser': '^1.0.0', 'proper-lockfile': '^4.0.0' },
    devDependencies: { '@scope/dropped-tool': '^2.0.0' }
  },
  { dependencies: { 'proper-lockfile': '^4.0.0' } }
)

/** Mirrors extraction: scan every release source file, then install the stand-ins. */
function installStandIns(
  checkout: ReleaseCheckout,
  files: Record<string, string>
): Promise<string[]> {
  const imports: DroppedImports = new Map()
  for (const source of Object.values(files)) {
    collectDroppedImports(source, dropped, imports)
  }
  return installDroppedDependencyStandIns(checkout.root, checkout.ref, imports)
}

describe('dropped release dependency stand-ins', () => {
  it('loads release code that imports a dropped package and refuses only its use', async () => {
    const files = {
      'src/parse.ts': [
        "import Parser, { Tokenizer, type Token as T, Kind } from 'dropped-parser'",
        "import { tool } from '@scope/dropped-tool/sub'",
        'export const loaded = true',
        'export const parse = () => new Tokenizer()',
        'export const kind = () => Kind.STRING',
        'export const run = () => tool()',
        'export const parserIsDefault = typeof Parser === "function"',
        ''
      ].join('\n')
    }
    const checkout = syntheticRelease(files)

    const installed = await installStandIns(checkout, files)
    const parse = await importReleaseCheckoutModule(checkout, '/src/parse.ts')

    const call = (name: string): unknown => {
      const exported = parse[name]
      if (typeof exported !== 'function') {
        throw new Error(`synthetic release has no ${name} export`)
      }
      return exported()
    }

    expect(installed).toEqual(['@scope/dropped-tool', 'dropped-parser'])
    expect(parse.loaded).toBe(true)
    expect(parse.parserIsDefault).toBe(true)
    const refusal = /release v0\.0\.0-synthetic imports 'dropped-parser'.*no longer installs/
    expect(() => call('parse')).toThrow(refusal)
    expect(() => call('kind')).toThrow(refusal)
    expect(() => call('run')).toThrow(/imports '@scope\/dropped-tool\/sub'.*\(used 'tool'\)/)
  })

  it('leaves packages the current tree still declares to the real install', async () => {
    const files = {
      'src/lock.ts': "import { lock } from 'proper-lockfile'\nexport const locker = lock\n"
    }
    const checkout = syntheticRelease(files)

    const installed = await installStandIns(checkout, files)

    expect(installed).toEqual([])
    expect(existsSync(join(checkout.root, 'node_modules'))).toBe(false)
  })

  it('keeps a package the release never declared a loud import failure', async () => {
    const files = {
      'src/undeclared.ts': "import { thing } from 'never-declared'\nexport const value = thing\n"
    }
    const checkout = syntheticRelease(files)

    await installStandIns(checkout, files)

    await expect(importReleaseCheckoutModule(checkout, '/src/undeclared.ts')).rejects.toThrow(
      /never-declared/
    )
  })
})
