import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { resolvePnpmCliInvocation } from './pnpm-cli-invocation.mjs'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../..')
if (
  process.env.GITHUB_ACTIONS !== 'true' ||
  process.platform !== 'darwin' ||
  root !== process.env.GITHUB_WORKSPACE
) {
  throw new Error('Disposable hosted macOS checkout required')
}
const { runProcessSync } = await import(
  pathToFileURL(join(process.env.RUNNER_TEMP, 'macos-store-process.mjs')).href
)
const output = join(process.env.RUNNER_TEMP, 'macos-root-store-comparison')
mkdirSync(output, { recursive: true })
const pnpm = resolvePnpmCliInvocation()
const command = (args) => {
  const result = runProcessSync({
    program: pnpm.command,
    args: [...pnpm.prefixArgs, ...args],
    cwd: root,
    timeoutMs: 300_000
  })
  if (result.code !== 0) {
    throw new Error(`pnpm failed: ${result.stderr}\n${result.stdout}`)
  }
  return result.stdout.trim()
}
const phase = process.argv[2]
const treatment = process.env.TREATMENT
const digest = (files) =>
  files.map((file) => {
    const path = join(root, file)
    return [
      file,
      existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'absent'
    ]
  })
const policies = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  '.pnpmfile.cjs'
]
if (phase === 'reset') {
  const store = command(['store', 'path', '--silent'])
  const cache = command(['cache', 'path'])
  for (const [path, suffix] of [
    [store, /\/store\/v\d+$/],
    [cache, /\/Library\/Caches\/pnpm$/]
  ]) {
    const scoped = relative(homedir(), path)
    if (
      !isAbsolute(path) ||
      isAbsolute(scoped) ||
      scoped === '' ||
      scoped === '..' ||
      scoped.startsWith(`..${sep}`) ||
      !suffix.test(path)
    ) {
      throw new Error(`Refuse unexpected reset path: ${path}`)
    }
    rmSync(path, { recursive: true, force: true })
  }
  rmSync(join(root, 'node_modules'), { recursive: true, force: true })
  appendFileSync(process.env.GITHUB_OUTPUT, `store=${store}\narch=${process.arch}\n`)
} else if (phase === 'start') {
  appendFileSync(process.env.GITHUB_OUTPUT, `started=${Date.now()}\n`)
} else if (phase === 'measure') {
  const started = Number(process.env.STARTED)
  if (!Number.isFinite(started) || started <= 0 || !['cached', 'registry'].includes(treatment)) {
    throw new Error('Invalid measurement')
  }
  if (treatment === 'cached' && process.env.CACHE_HIT !== 'true') {
    throw new Error('Actual main store cache hit required')
  }
  const before = digest(policies)
  const installStart = Date.now()
  const log = command(['install', '--frozen-lockfile', '--ignore-scripts'])
  const finished = Date.now()
  writeFileSync(join(output, `${treatment}.log`), log)
  if (JSON.stringify(before) !== JSON.stringify(digest(policies))) {
    throw new Error('Frozen install changed policy files')
  }
  const installed = digest(['node_modules/.pnpm/lock.yaml'])
  if (installed[0][1] === 'absent') {
    throw new Error('Installed lockfile is missing')
  }
  const path = join(output, `${treatment}.json`)
  const row = {
    sample: process.env.SAMPLE,
    treatment,
    node: process.version,
    arch: process.arch,
    pnpm: command(['--version']),
    policy: before,
    installed,
    totalMs: finished - started,
    installMs: finished - installStart
  }
  const other = join(output, `${treatment === 'cached' ? 'registry' : 'cached'}.json`)
  if (existsSync(other)) {
    const prior = JSON.parse(readFileSync(other, 'utf8'))
    if (
      JSON.stringify(prior.policy) !== JSON.stringify(row.policy) ||
      JSON.stringify(prior.installed) !== JSON.stringify(row.installed) ||
      prior.pnpm !== row.pnpm
    ) {
      throw new Error('Paired installed lockfiles or policies differ')
    }
  }
  writeFileSync(path, JSON.stringify(row))
  console.log(JSON.stringify({ ...row, policy: 'validated', installed: 'validated' }))
} else {
  throw new Error('Expected reset, start or measure')
}
