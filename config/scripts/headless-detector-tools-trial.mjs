import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { collectNodeServerInputs } from './node-server-change-scope.mjs'

const root = process.cwd()
const require = createRequire(import.meta.url)
const tools = join(process.env.RUNNER_TEMP, 'headless-detector-tools')
const results = join(process.env.RUNNER_TEMP, 'headless-detector-comparison')
const nativeName = '@esbuild/linux-x64'
const phase = process.argv[2]
if (
  process.env.GITHUB_ACTIONS !== 'true' ||
  process.platform !== 'linux' ||
  process.arch !== 'x64' ||
  root !== process.env.GITHUB_WORKSPACE
) {
  throw new Error('Disposable Linux x64 checkout required')
}
mkdirSync(results, { recursive: true })
function inventory(directory, prefix = '') {
  return readdirSync(directory)
    .flatMap((name) => {
      const file = join(directory, name),
        key = prefix + name,
        stat = lstatSync(file)
      if (stat.isSymbolicLink()) {
        throw new Error('Unexpected tool symlink')
      }
      if (stat.isDirectory()) {
        return inventory(file, `${key}/`)
      }
      if (!stat.isFile()) {
        throw new Error('Unexpected tool file kind')
      }
      return [{ file: key, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') }]
    })
    .sort((a, b) => a.file.localeCompare(b.file))
}
if (phase === 'pack') {
  const esbuildDir = dirname(require.resolve('esbuild/package.json'))
  const nativeDir = dirname(require.resolve(`${nativeName}/package.json`, { paths: [esbuildDir] }))
  rmSync(tools, { recursive: true, force: true })
  mkdirSync(join(tools, 'node_modules', '@esbuild'), { recursive: true })
  cpSync(esbuildDir, join(tools, 'node_modules', 'esbuild'), { recursive: true, dereference: true })
  cpSync(nativeDir, join(tools, 'node_modules', nativeName), { recursive: true, dereference: true })
  const version = require('esbuild').version
  const manifest = { version, node: process.version, files: inventory(tools) }
  writeFileSync(join(tools, 'manifest.json'), JSON.stringify(manifest))
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`)
} else if (phase === 'reset') {
  rmSync(join(root, 'node_modules'), { recursive: true, force: true })
} else if (phase === 'start') {
  appendFileSync(process.env.GITHUB_OUTPUT, `started=${Date.now()}\n`)
} else if (phase === 'activate') {
  if (process.env.TOOL_CACHE_HIT !== 'true') {
    throw new Error('Require an actual cache hit')
  }
  const manifest = JSON.parse(readFileSync(join(tools, 'manifest.json'), 'utf8'))
  if (
    manifest.version !== process.env.EXPECTED_ESBUILD_VERSION ||
    manifest.node !== process.version
  ) {
    throw new Error('Tool identity mismatch')
  }
  const files = inventory(tools).filter((row) => row.file !== 'manifest.json')
  if (JSON.stringify(files) !== JSON.stringify(manifest.files)) {
    throw new Error('Tool inventory mismatch')
  }
  if (existsSync(join(root, 'node_modules'))) {
    throw new Error('Fresh dependency tree required')
  }
  mkdirSync(join(root, 'node_modules', '@esbuild'), { recursive: true })
  symlinkSync(join(tools, 'node_modules', 'esbuild'), join(root, 'node_modules', 'esbuild'), 'dir')
  symlinkSync(
    join(tools, 'node_modules', nativeName),
    join(root, 'node_modules', nativeName),
    'dir'
  )
  const esbuild = await import('esbuild')
  if (esbuild.version !== manifest.version) {
    throw new Error('Compiler API version mismatch')
  }
  await esbuild.build({
    stdin: { contents: 'export const value = 1' },
    write: false,
    logLevel: 'silent'
  })
} else if (phase === 'measure') {
  const started = Number(process.env.STARTED)
  if (!Number.isFinite(started) || started <= 0) {
    throw new Error('Valid start time required')
  }
  const inputs = [...(await collectNodeServerInputs())].sort()
  const row = {
    sample: process.env.SAMPLE,
    treatment: process.env.TREATMENT,
    node: process.version,
    esbuild: require('esbuild').version,
    inputs,
    elapsedMs: Date.now() - started
  }
  writeFileSync(join(results, `${process.env.TREATMENT}.json`), JSON.stringify(row))
  const other = join(
    results,
    `${process.env.TREATMENT === 'baseline' ? 'candidate' : 'baseline'}.json`
  )
  if (existsSync(other)) {
    const prior = JSON.parse(readFileSync(other, 'utf8'))
    if (
      JSON.stringify(prior.inputs) !== JSON.stringify(row.inputs) ||
      prior.node !== row.node ||
      prior.esbuild !== row.esbuild
    ) {
      throw new Error('Classifier graph or toolchain differs')
    }
  }
  console.log(JSON.stringify({ ...row, inputs: inputs.length }))
} else {
  throw new Error('Unknown phase')
}
