// Assigns every file #16741 changes to a D9 port track (docs/reference/node-runtime-design.html).
// Usage: git fetch origin pull/16741/head:refs/pr/16741
//        node config/scripts/pr16741-track-manifest.mjs [--main-ref origin/main]
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { TRACKS, TRACK_RULES } from './pr16741-track-rules.mjs'

export const PR16741 = {
  number: 16741,
  ref: 'refs/pr/16741',
  // Why frozen: D9 ports from this head; a moved ref would silently reclassify a different PR.
  head: 'a68b6f35311012846a423654cee72866567b14cd',
  mergeBase: '277c289bd41d896f028f7f172bca194a70117f55'
}

export const MANIFEST_PATH = 'config/scripts/pr16741-track-manifest.json'

function globSource(glob) {
  let out = ''
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]
    if (char === '{') {
      const alternatives = ['']
      let depth = 1
      let end = i + 1
      for (; end < glob.length && depth > 0; end += 1) {
        const inner = glob[end]
        depth += inner === '{' ? 1 : inner === '}' ? -1 : 0
        if (depth === 1 && inner === ',') {
          alternatives.push('')
        } else if (depth > 0) {
          alternatives[alternatives.length - 1] += inner
        }
      }
      if (depth > 0) {
        throw new Error(`Unclosed brace in glob: ${glob}`)
      }
      out += `(?:${alternatives.map((alternative) => globSource(alternative)).join('|')})`
      i = end - 1
    } else if (char === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/'
      out += slash ? '(?:.*/)?' : '.*'
      i += slash ? 2 : 1
    } else if (char === '*') {
      out += '[^/]*'
    } else {
      out += char.replace(/[.+?^$()|[\]\\]/g, '\\$&')
    }
  }
  return out
}

/** Compiles `*`, `**` and `{a,b}` globs into one anchored RegExp matching any of them. */
export function compileGlobs(globs) {
  return new RegExp(`^(?:${globs.map((glob) => globSource(glob)).join('|')})$`)
}

const COMPILED_RULES = TRACK_RULES.map((rule) => ({ ...rule, pattern: compileGlobs(rule.globs) }))

const TEST_PATH_PATTERNS = [
  /(^|\/)tests?\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /-test-[a-z]+/,
  /(^|[-/.])(fixture|fixtures|harness|mocks?)([-.]|$)/,
  /[-.](smoke|soak|e2e|poc)[-.]/
]

export function isTestPath(path) {
  return TEST_PATH_PATTERNS.some((pattern) => pattern.test(path))
}

/** Returns the first matching rule's track and disposition, or null when no rule covers the path. */
export function classifyPath(path, rules = COMPILED_RULES) {
  for (const rule of rules) {
    const pattern = rule.pattern ?? compileGlobs(rule.globs)
    if (pattern.test(path)) {
      const disposition = rule.dropped ? 'dropped' : (TRACKS[rule.track].disposition ?? 'port')
      return { track: rule.track, disposition, reason: rule.dropped ?? null }
    }
  }
  return null
}

/** Parses `git diff -z --numstat`; renames carry an empty path followed by old and new paths. */
export function parseNumstatZ(output) {
  const fields = output.split('\0')
  const entries = []
  for (let i = 0; i < fields.length; i += 1) {
    const header = fields[i]
    if (!header) {
      continue
    }
    const [added, deleted, path] = header.split('\t')
    const binary = added === '-' && deleted === '-'
    const entry = {
      path,
      added: binary ? 0 : Number(added),
      deleted: binary ? 0 : Number(deleted),
      binary
    }
    if (path === '') {
      entry.previousPath = fields[i + 1]
      entry.path = fields[i + 2]
      i += 2
    }
    if (!entry.path || !Number.isInteger(entry.added) || !Number.isInteger(entry.deleted)) {
      throw new Error(`Unparseable numstat record: ${JSON.stringify(header)}`)
    }
    entries.push(entry)
  }
  return entries
}

/**
 * Classifies numstat entries. `mainDivergence` maps paths where main has independently
 * added or removed the file; those need reconciling, not a straight port.
 */
export function buildManifest(entries, { mainDivergence = new Map() } = {}) {
  const tracks = Object.fromEntries(
    Object.entries(TRACKS).map(([id, track]) => [
      id,
      {
        title: track.title,
        disposition: track.disposition ?? 'port',
        files: 0,
        prodAdded: 0,
        prodDeleted: 0,
        testAdded: 0,
        testDeleted: 0
      }
    ])
  )
  const files = {}
  const notes = {}
  const unassigned = []
  for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const match = classifyPath(entry.path)
    if (!match) {
      unassigned.push(entry.path)
      continue
    }
    const kind = isTestPath(entry.path) ? 'test' : 'prod'
    const divergence = match.disposition === 'port' ? mainDivergence.get(entry.path) : undefined
    const disposition = divergence ? 'reconcile' : match.disposition
    files[entry.path] = [match.track, disposition, kind, entry.added, entry.deleted]
    const note = [
      entry.previousPath ? `renamed from ${entry.previousPath}` : null,
      entry.binary ? 'binary' : null,
      divergence ?? match.reason
    ].filter(Boolean)
    if (note.length > 0) {
      notes[entry.path] = note.join('; ')
    }
    const summary = tracks[match.track]
    summary.files += 1
    summary[`${kind}Added`] += entry.added
    summary[`${kind}Deleted`] += entry.deleted
  }
  return { tracks, files, notes, unassigned }
}

export function formatSummary(tracks) {
  const header = ['Track', 'Disposition', 'Files', 'Prod +/-', 'Test +/-', 'Title']
  const rows = Object.entries(tracks).map(([id, track]) => [
    id,
    track.disposition,
    String(track.files),
    `${track.prodAdded}/${track.prodDeleted}`,
    `${track.testAdded}/${track.testDeleted}`,
    track.title
  ])
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => row[column].length))
  )
  const line = (cells) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column]))
      .join('  ')
      .trimEnd()
  return [line(header), ...rows.map(line)].join('\n')
}

const PRINT_WIDTH = 100

// oxfmt's JSON layout (objects expanded, arrays inline when they fit), so regeneration is diff-stable.
export function serializeJson(value, indent = '', prefix = '', suffix = '') {
  if (Array.isArray(value)) {
    const inline = `[${value.map((item) => JSON.stringify(item)).join(', ')}]`
    const fits = `${indent}${prefix}${inline}${suffix}`.length <= PRINT_WIDTH
    if (value.length === 0 || fits) {
      return `${indent}${prefix}${inline}${suffix}`
    }
    const items = value.map((item, index) =>
      serializeJson(item, `${indent}  `, '', index < value.length - 1 ? ',' : '')
    )
    return [`${indent}${prefix}[`, ...items, `${indent}]${suffix}`].join('\n')
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
    if (entries.length === 0) {
      return `${indent}${prefix}{}${suffix}`
    }
    const lines = entries.map(([key, item], index) =>
      serializeJson(
        item,
        `${indent}  `,
        `${JSON.stringify(key)}: `,
        index < entries.length - 1 ? ',' : ''
      )
    )
    return [`${indent}${prefix}{`, ...lines, `${indent}}${suffix}`].join('\n')
  }
  return `${indent}${prefix}${JSON.stringify(value)}${suffix}`
}

async function git(args) {
  const { runProcessSync } = await import('./script-child-process.mjs')
  const result = runProcessSync({ program: 'git', args, maxOutputBytes: 64 * 1024 * 1024 })
  if (result.code !== 0 || result.timedOut) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`)
  }
  return result.stdout
}

/**
 * Paths where main diverged from the PR's merge-base. A rename is judged by its source: its new
 * path is absent from main by construction, so only a missing source means main moved on.
 */
export function findMainDivergence(entries, { addedPaths, mainPaths }) {
  const divergence = new Map()
  for (const entry of entries) {
    const created = addedPaths.has(entry.path) || entry.previousPath !== undefined
    if (created && mainPaths.has(entry.path)) {
      divergence.set(entry.path, 'main has since added its own copy; port the delta only')
    } else if (entry.previousPath !== undefined && !mainPaths.has(entry.previousPath)) {
      divergence.set(entry.path, 'main has since removed or renamed the rename source')
    } else if (!created && !mainPaths.has(entry.path)) {
      divergence.set(entry.path, 'main has since removed or renamed this file')
    }
  }
  return divergence
}

async function collectMainDivergence(entries, mainRef) {
  const statuses = (
    await git(['diff', '-z', '--name-status', '--find-renames', PR16741.mergeBase, PR16741.ref])
  ).split('\0')
  const addedPaths = new Set()
  for (let i = 0; i < statuses.length; i += 1) {
    const status = statuses[i]
    if (!status) {
      continue
    }
    if (status === 'A') {
      addedPaths.add(statuses[i + 1])
    }
    i += status.startsWith('R') || status.startsWith('C') ? 2 : 1
  }
  // One tree listing of main; no per-ref fan-out.
  const mainPaths = new Set(
    (await git(['ls-tree', '-r', '--name-only', '-z', mainRef])).split('\0')
  )
  return findMainDivergence(entries, { addedPaths, mainPaths })
}

async function main(argv) {
  const mainRefIndex = argv.indexOf('--main-ref')
  const mainRef = mainRefIndex !== -1 ? argv[mainRefIndex + 1] : 'origin/main'
  const head = (
    await git(['rev-parse', '--verify', `${PR16741.ref}^{commit}`]).catch(() => {
      throw new Error(
        `Missing ${PR16741.ref}; run: git fetch origin pull/16741/head:${PR16741.ref}`
      )
    })
  ).trim()
  if (head !== PR16741.head) {
    throw new Error(`${PR16741.ref} is ${head}, not the frozen head ${PR16741.head}`)
  }
  const mainSha = (await git(['rev-parse', '--verify', `${mainRef}^{commit}`])).trim()
  const entries = parseNumstatZ(
    await git(['diff', '-z', '--numstat', '--find-renames', PR16741.mergeBase, PR16741.ref])
  )
  const manifest = buildManifest(entries, {
    mainDivergence: await collectMainDivergence(entries, mainSha)
  })
  if (manifest.unassigned.length > 0) {
    console.error(`${manifest.unassigned.length} file(s) match no track rule:`)
    for (const path of manifest.unassigned) {
      console.error(`  ${path}`)
    }
    process.exitCode = 1
    return
  }
  const output = {
    generatedBy: 'config/scripts/pr16741-track-manifest.mjs',
    pr: { number: PR16741.number, head: PR16741.head, mergeBase: PR16741.mergeBase },
    main: { ref: mainRef, sha: mainSha },
    fileColumns: ['track', 'disposition', 'kind', 'added', 'deleted'],
    tracks: manifest.tracks,
    files: manifest.files,
    notes: manifest.notes
  }
  writeFileSync(resolve(MANIFEST_PATH), `${serializeJson(output)}\n`)
  console.log(`${entries.length} files from #${PR16741.number} -> ${MANIFEST_PATH}\n`)
  console.log(formatSummary(manifest.tracks))
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
