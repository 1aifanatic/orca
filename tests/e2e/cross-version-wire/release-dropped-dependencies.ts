import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type PackageManifest = {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

/** Specifier (package or package subpath) to the names release source imports from it. */
export type DroppedImports = Map<string, Set<string>>

// Clause stops at quotes so it cannot swallow an earlier import's specifier.
const STATIC_IMPORT = /\b(?:import|export)\s+(?:type\s+)?([^;'"]*?)\s*\bfrom\s*(['"])([^'"]+)\2/g
const BARE_IMPORT = /\bimport\s*(?:\(\s*)?(['"])([^'"]+)\1/g
const EXPORT_NAME = /^[A-Za-z_$][\w$]*$/

function declaredPackages(manifest: PackageManifest): Set<string> {
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {})
  ])
}

/** Packages the release declares that the current tree no longer declares. */
export function droppedReleasePackages(
  releaseManifest: PackageManifest,
  currentManifest: PackageManifest
): Set<string> {
  const current = declaredPackages(currentManifest)
  return new Set([...declaredPackages(releaseManifest)].filter((name) => !current.has(name)))
}

function packageNameOf(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
}

function importedNames(clause: string): string[] {
  const names: string[] = []
  const outside = clause
    .replace(/\{[^}]*\}/, '')
    .trim()
    .replace(/,$/, '')
    .trim()
  if (outside && !outside.startsWith('*')) {
    names.push('default')
  }
  for (const part of clause.match(/\{([^}]*)\}/)?.[1]?.split(',') ?? []) {
    const name = part
      .trim()
      .replace(/^type\s+/, '')
      .split(/\s+as\s+/)[0]
      ?.trim()
    if (name && EXPORT_NAME.test(name)) {
      names.push(name)
    }
  }
  return names
}

/** Record what one release source file imports from dropped packages. */
export function collectDroppedImports(
  source: string,
  dropped: ReadonlySet<string>,
  imports: DroppedImports
): void {
  if (![...dropped].some((name) => source.includes(name))) {
    return
  }
  for (const [, , specifier] of source.matchAll(BARE_IMPORT)) {
    if (dropped.has(packageNameOf(specifier!)) && !imports.has(specifier!)) {
      imports.set(specifier!, new Set())
    }
  }
  for (const [, clause, , specifier] of source.matchAll(STATIC_IMPORT)) {
    if (!dropped.has(packageNameOf(specifier!))) {
      continue
    }
    const names = imports.get(specifier!) ?? new Set()
    for (const name of importedNames(clause!)) {
      names.add(name)
    }
    imports.set(specifier!, names)
  }
}

function standInModule(release: string, specifier: string, names: Set<string>): string {
  const reason =
    `Cross-version harness: release ${release} imports '${specifier}', which it declares ` +
    'but the current tree no longer installs, so this release code path cannot run here.'
  const lines = [
    `const reason = ${JSON.stringify(reason)}`,
    'function unavailable(name) {',
    "  const refuse = () => { throw new Error(`${reason} (used '${name}')`) }",
    '  return new Proxy(function unavailableExport() {}, {',
    // Why: module interop probes these at import time; any real use still refuses.
    "    get: (_target, key) => typeof key === 'symbol' || key === '__esModule' || key === 'then' ? undefined : refuse(),",
    '    apply: refuse,',
    '    construct: refuse',
    '  })',
    '}'
  ]
  for (const name of [...names].sort()) {
    lines.push(
      name === 'default'
        ? "export default unavailable('default')"
        : `export const ${name} = unavailable(${JSON.stringify(name)})`
    )
  }
  return `${lines.join('\n')}\n`
}

/**
 * Why: release source runs against the current install, and the release's RPC dispatcher
 * imports its whole method table, so one package the current tree dropped fails every wire
 * suite at import time. Each such package gets a stand-in in the checkout's own
 * `node_modules` that loads but refuses any use, naming the package. A package the release
 * never declared is left to fail loudly.
 */
export async function installDroppedDependencyStandIns(
  root: string,
  release: string,
  imports: DroppedImports
): Promise<string[]> {
  const byPackage = new Map<string, string[]>()
  for (const specifier of imports.keys()) {
    const name = packageNameOf(specifier)
    byPackage.set(name, [...(byPackage.get(name) ?? []), specifier])
  }
  for (const [name, specifiers] of byPackage) {
    const directory = join(root, 'node_modules', ...name.split('/'))
    await mkdir(directory, { recursive: true })
    const exportsMap: Record<string, string> = {}
    for (const [index, specifier] of specifiers.sort().entries()) {
      const file = `stand-in-${index}.js`
      exportsMap[`.${specifier.slice(name.length)}`] = `./${file}`
      await writeFile(
        join(directory, file),
        standInModule(release, specifier, imports.get(specifier) ?? new Set())
      )
    }
    await writeFile(
      join(directory, 'package.json'),
      `${JSON.stringify({ name, version: '0.0.0-cross-version-stand-in', type: 'module', exports: exportsMap }, null, 2)}\n`
    )
  }
  return [...byPackage.keys()].sort()
}
