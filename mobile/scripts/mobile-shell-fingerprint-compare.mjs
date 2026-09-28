export const FINGERPRINT_FORMAT = 1
export const PLATFORMS = ['android', 'ios']
export const VARIANTS = ['native', 'ota']
const LISTED_FILE_LIMIT = 40

function diffKeyedDigests(base, head) {
  const added = Object.keys(head).filter((key) => !(key in base))
  const removed = Object.keys(base).filter((key) => !(key in head))
  const changed = Object.keys(head).filter((key) => key in base && base[key] !== head[key])
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() }
}

function sourcesById(sources) {
  return Object.fromEntries(sources.map((source) => [`${source.type} ${source.id}`, source.hash]))
}

/** Pure verdict over two `compute` records; `changed` is null when they cannot be compared. */
export function compareShellFingerprints(base, head) {
  if (base?.format !== FINGERPRINT_FORMAT || head?.format !== FINGERPRINT_FORMAT) {
    return { changed: null, reason: 'fingerprint format differs', parts: [], files: null }
  }
  const parts = []
  for (const platform of PLATFORMS) {
    if (base.native[platform].hash !== head.native[platform].hash) {
      const inputs = diffKeyedDigests(
        sourcesById(base.native[platform].sources),
        sourcesById(head.native[platform].sources)
      )
      parts.push({ kind: 'native', platform, inputs })
    }
  }
  const files = { added: new Set(), removed: new Set(), changed: new Set() }
  for (const variant of VARIANTS) {
    for (const platform of PLATFORMS) {
      const before = base.shellJs[variant][platform]
      const after = head.shellJs[variant][platform]
      if (before.hash === after.hash) {
        continue
      }
      parts.push({ kind: 'shellJs', variant, platform })
      const diff = diffKeyedDigests(before.modules, after.modules)
      for (const kind of ['added', 'removed', 'changed']) {
        diff[kind].forEach((file) => files[kind].add(file))
      }
    }
  }
  const sorted = (set) => [...set].sort()
  return {
    changed: parts.length > 0,
    reason: null,
    parts,
    files: {
      added: sorted(files.added),
      removed: sorted(files.removed),
      changed: sorted(files.changed)
    }
  }
}

export function partLabel(part) {
  if (part.kind === 'native') {
    return `native project (${part.platform})`
  }
  return `${part.variant === 'ota' ? 'OTA-shell' : 'native-shell'} JS (${part.platform})`
}

const PACKAGE_FILE = /^(mobile\/node_modules\/(?:@[^/]+\/)?[^/]+)\//

/** Collapses dependency files to one line per package so a bump does not flood the list. */
export function explainingFiles(files) {
  const lines = []
  for (const kind of ['changed', 'added', 'removed']) {
    const packages = new Map()
    for (const file of files[kind]) {
      const pkg = PACKAGE_FILE.exec(file)?.[1]
      if (pkg) {
        packages.set(pkg, (packages.get(pkg) ?? 0) + 1)
      } else {
        lines.push(`${kind}: ${file}`)
      }
    }
    for (const [pkg, count] of packages) {
      lines.push(`${kind}: ${pkg}/ (${count} file${count === 1 ? '' : 's'})`)
    }
  }
  return lines
}

function bulletList(lines) {
  const shown = lines.slice(0, LISTED_FILE_LIMIT).map((line) => `- \`${line}\``)
  if (lines.length > LISTED_FILE_LIMIT) {
    shown.push(`- … and ${lines.length - LISTED_FILE_LIMIT} more`)
  }
  return shown
}

function headline(verdict, since) {
  const parts = verdict.parts.map(partLabel).join(', ')
  if (since) {
    return verdict.changed
      ? `Mobile release needed since ${since}: yes — ${parts}`
      : `Mobile release needed since ${since}: no — OTA delivers everything since`
  }
  return verdict.changed
    ? `Mobile shell: changed — ${parts}`
    : 'Mobile shell: unchanged — OTA delivers this'
}

/** `since` names the release tag the base record was computed at; empty for a pull request. */
export function renderShellVerdictMarkdown(verdict, since = '') {
  if (verdict.changed === null) {
    return `### Mobile shell: verdict unknown — ${verdict.reason}\n`
  }
  const lines = [`### ${headline(verdict, since)}`]
  for (const part of verdict.parts.filter((entry) => entry.kind === 'native')) {
    lines.push('', `Native inputs (${part.platform}):`)
    lines.push(...bulletList(explainingFiles(part.inputs)))
  }
  if (verdict.parts.some((part) => part.kind === 'shellJs')) {
    const files = explainingFiles(verdict.files)
    lines.push('', 'Sources that differ inside the changed bundles:')
    lines.push(
      ...(files.length > 0
        ? bulletList(files)
        : ['- no source module differs: an inlined constant, a transform, or a bundler change'])
    )
  }
  return `${lines.join('\n')}\n`
}
