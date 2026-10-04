const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const { createRequire } = require('node:module')
const { compileFunction } = require('node:vm')

const source = 'c6bc30f831f280c7b018aaad98fcf7b29d00877d'
const expectedBundleHash = 'a9debf460474f83cce87322d1e6634b5c35a2025fe59a6adf01ae6cb293aea99'
const expectedStockHash = 'b5204b4125dbb318195b95b54ac329c02bb1867b46d573d40f951c77656b3822'
const sha = (raw) => crypto.createHash('sha256').update(raw).digest('hex')
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
const repository = path.resolve(process.argv[2])
const output = path.resolve(process.argv[3])
const replayStock = process.argv[4] && path.resolve(process.argv[4])
const boundary = replayStock ? 'macOS stock-prefix causal replay' : 'Linux stock global startup'
if (replayStock ? process.platform !== 'darwin' : process.platform !== 'linux') {
  throw new Error('Execution platform does not match the declared boundary')
}
fs.mkdirSync(output, { recursive: true })
const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-stock-zsh-diagnostic-'))
const privateEnvironment = (home) => {
  const env = {
    HOME: home,
    USERPROFILE: home,
    PATH: `${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
    ORCA_BACKGROUND_LAUNCH: '1',
    TMPDIR: path.join(home, 'tmp'),
    TMP: path.join(home, 'tmp'),
    TEMP: path.join(home, 'tmp')
  }
  for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) {
    env[name] = path.join(home, name.toLowerCase())
  }
  for (const name of [
    'HOME',
    'TMPDIR',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'XDG_CACHE_HOME'
  ]) {
    fs.mkdirSync(env[name], { recursive: true })
  }
  return env
}
const env = privateEnvironment(path.join(privateRoot, 'controller'))
for (const name of Object.keys(process.env)) {
  delete process.env[name]
}
Object.assign(process.env, env)
const git = (...args) =>
  cp.execFileSync('git', ['-C', repository, ...args], {
    env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' }
  })
const writeJSON = (name, value) =>
  fs.writeFileSync(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`)
const stockPath = replayStock || '/etc/zsh/zshrc'
const stock = fs.readFileSync(stockPath)
fs.writeFileSync(path.join(output, 'stock-zshrc.raw'), stock)
writeJSON('initial-runtime-guard.json', {
  source,
  boundary,
  platform: process.platform,
  architecture: process.arch,
  node: process.version,
  privateRoot,
  checkout: git('rev-parse', 'HEAD').toString().trim(),
  sourceTree: git('rev-parse', `${source}^{tree}`).toString().trim(),
  stock: { path: stockPath, bytes: stock.length, sha256: sha(stock) },
  isolation: [
    'HOME',
    'USERPROFILE',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'XDG_CACHE_HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'ORCA_BACKGROUND_LAUNCH'
  ],
  scope:
    'Four private interactive login PTYs; controlled CLI lookup and deferred initialization only. No application, provider, auth, remote host, or service.'
})
if (sha(stock) !== expectedStockHash) {
  throw new Error('Stock zshrc differs from the original failing Ubuntu package')
}
if (!replayStock) {
  fs.writeFileSync(
    path.join(output, 'package-versions.raw'),
    cp.execFileSync('dpkg-query', ['-W', 'zsh', 'zsh-common'], { env })
  )
}
const keyboard = `${stock.toString().split('\n').slice(0, 93).join('\n')}\n`
const keyboardPath = path.join(output, 'stock-keyboard-prefix.zsh')
fs.writeFileSync(keyboardPath, keyboard)
const esbuild = require(path.join(repository, 'node_modules/esbuild'))
const inputs = new Map()
const children = []
const nativeSpawn = cp.spawn
cp.spawn = (...args) => {
  const child = nativeSpawn(...args)
  const row = { pid: child.pid, argv: [args[0], ...(args[1] || [])] }
  children.push(row)
  child.on('exit', (code, signal) => {
    row.exit = { code, signal }
  })
  return child
}
const compiledPath = path.join(output, 'compiled-exact-c6bc.cjs')
const ptys = []
const rows = []
;(async () => {
  if (esbuild.version !== '0.28.2') {
    throw new Error('Compiler version differs from the frozen bundle')
  }
  const result = await esbuild.build({
    stdin: {
      contents: `export { getZshShellReadyWrapperFile } from './src/main/providers/local-pty-shell-ready-wrapper-generation';
export { prependOrcaCliDirToChildPath } from './src/main/cli/orca-cli-child-path';
export { selectShellStartupFeatures, encodeShellStartupFeatures } from './src/main/shell-startup-features';
export { runZshPty, ZSH_PATH } from './src/main/zsh-startup-hook-pty-harness';`,
      resolveDir: repository,
      sourcefile: 'real-zsh-evidence-entry.ts',
      loader: 'ts'
    },
    absWorkingDir: repository,
    outfile: compiledPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    metafile: true,
    plugins: [
      {
        name: 'exact-named-source',
        setup(build) {
          build.onLoad({ filter: /\.tsx?$/ }, (args) => {
            const name = path.relative(repository, args.path).split(path.sep).join('/')
            if (name.startsWith('../')) {
              throw new Error('Input escapes named source')
            }
            const raw = git('show', `${source}:${name}`)
            inputs.set(name, {
              path: name,
              bytes: raw.length,
              sha256: sha(raw),
              blob: git('rev-parse', `${source}:${name}`).toString().trim()
            })
            return { contents: raw.toString(), loader: name.endsWith('.tsx') ? 'tsx' : 'ts' }
          })
        }
      }
    ]
  })
  esbuild.stop()
  const compiled = fs.readFileSync(compiledPath)
  writeJSON('compiled-source-closure.json', {
    source,
    inputs: [...inputs.values()],
    metafile: result.metafile,
    compiled: { bytes: compiled.length, sha256: sha(compiled) },
    compilerVersion: esbuild.version
  })
  if (inputs.size !== 56 || sha(compiled) !== expectedBundleHash) {
    throw new Error('Compiled source is not the exact frozen 56-module bundle')
  }
  const pty = require(path.join(repository, 'node_modules/node-pty'))
  const spawnPty = pty.spawn
  pty.spawn = (...args) => {
    const proc = spawnPty(...args)
    const row = {
      pid: proc.pid,
      argv: [args[0], ...args[1]],
      cwd: args[2].cwd,
      startedAt: new Date().toISOString()
    }
    ptys.push(row)
    proc.onExit((exit) => {
      row.exit = exit
      row.exitedAt = new Date().toISOString()
    })
    return proc
  }
  const compiledModule = { exports: {} }
  compileFunction(
    compiled.toString(),
    ['exports', 'require', 'module', '__filename', '__dirname'],
    { filename: compiledPath }
  )(
    compiledModule.exports,
    createRequire(path.join(repository, 'package.json')),
    compiledModule,
    compiledPath,
    path.dirname(compiledPath)
  )
  const product = compiledModule.exports
  for (const stockKeyboard of [false, true]) {
    for (const dropPrecmd of [false, true]) {
      const name = `${stockKeyboard ? 'stock' : 'stock-disabled'}-${dropPrecmd ? 'cleared' : 'retained'}`
      const home = path.join(privateRoot, name)
      const childEnv = privateEnvironment(home)
      const wrapper = path.join(home, 'wrapper')
      const ambient = path.join(home, 'ambient-bin')
      const bin = path.join(home, 'cli/bin')
      for (const dir of [wrapper, ambient, bin]) {
        fs.mkdirSync(dir, { recursive: true })
      }
      for (const dir of [ambient, bin]) {
        fs.writeFileSync(path.join(dir, 'orca-dev'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      }
      if (!stockKeyboard) {
        childEnv.DEBIAN_PREVENT_KEYBOARD_CHANGES = '1'
      }
      const stage =
        'print -r -- "widget=${widgets[zle-line-init]:-UNSET}" "smkx=${+terminfo[smkx]}" "rmkx=${+terminfo[rmkx]}" "precmd=${precmd_functions[*]}"'
      const rc = `${
        (replayStock ? 'builtin source ' + quote(keyboardPath) + '\n' : '') + stage
      } > "$HOME/before-user-reset.txt"\nexport PATH="$HOME/ambient-bin:/usr/bin:/bin:$HOME/cli/bin"\n${
        dropPrecmd ? 'precmd_functions=()\n' : ''
      }${stage} > "$HOME/after-user-reset.txt"\n`
      fs.writeFileSync(path.join(home, '.zshrc'), rc)
      fs.writeFileSync(path.join(wrapper, '.zshenv'), product.getZshShellReadyWrapperFile())
      fs.writeFileSync(path.join(wrapper, '.orca-shell-wrapper'), '')
      childEnv.ZDOTDIR = wrapper
      childEnv.PATH = `${ambient}:/usr/bin:/bin`
      const expected = product.prependOrcaCliDirToChildPath(childEnv, {
        isPackaged: false,
        userDataPath: home
      })
      const originalFeatures = product.selectShellStartupFeatures({
        shellPath: product.ZSH_PATH,
        env: childEnv,
        hasStartupCommand: true,
        waitsForShellReady: false,
        emitsStartupIdentity: false
      })
      childEnv.ORCA_SHELL_FEATURES = product.encodeShellStartupFeatures(originalFeatures)
      const captured = await product.runZshPty({
        env: childEnv,
        cwd: home,
        commands: [
          'ORCA_LOOKUP=$(command -v orca-dev)',
          'ORCA_WIDGET="${widgets[zle-line-init]:-UNSET}"',
          'ORCA_INIT_DONE="${_orca_deferred_init_done:-0}"'
        ],
        report: ['ORCA_LOOKUP', 'ORCA_WIDGET', 'ORCA_INIT_DONE', 'ORCA_STARTUP_RUNS']
      })
      fs.writeFileSync(path.join(output, `${name}-transcript.raw`), captured.output)
      writeJSON(`${name}-result.json`, captured)
      const stages = {}
      for (const label of ['before-user-reset', 'after-user-reset']) {
        const raw = fs.readFileSync(path.join(home, `${label}.txt`))
        stages[label] = raw.toString()
        fs.writeFileSync(path.join(output, `${name}-${label}.raw`), raw)
      }
      const expectedFailure = stockKeyboard && dropPrecmd
      rows.push({
        name,
        stockKeyboard,
        dropPrecmd,
        expectedFailure,
        selectedFeatures: originalFeatures,
        stages,
        values: captured.values,
        wrapperSHA256: sha(fs.readFileSync(path.join(wrapper, '.zshenv'))),
        transcriptSHA256: sha(Buffer.from(captured.output)),
        shell: ptys.at(-1)
      })
      writeJSON('four-control-observations.json', {
        source,
        boundary,
        privateRoot,
        rows,
        ptys,
        children
      })
      if (
        captured.values.ORCA_LOOKUP !==
        (expectedFailure ? path.join(ambient, 'orca-dev') : expected)
      ) {
        throw new Error(`Unexpected CLI selection: ${name}`)
      }
      if (
        captured.values.ORCA_INIT_DONE !== (expectedFailure ? '0' : '1') ||
        captured.values.ORCA_STARTUP_RUNS !== 'UNSET'
      ) {
        throw new Error(`Unexpected initialization: ${name}`)
      }
    }
  }
  if (ptys.length !== 4 || ptys.some((row) => !row.exit || row.exit.exitCode !== 0)) {
    throw new Error('Missing positive PTY exits')
  }
  for (let tick = 0; tick < 100 && children.some((row) => !row.exit); tick++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  if (children.some((row) => !row.exit)) {
    throw new Error('Missing positive compiler-child exit')
  }
  const ps = cp.execFileSync('ps', ['-eo', 'pid=,ppid=,lstart=,args='], { env, encoding: 'utf8' })
  const live = ps.split('\n').filter((line) => line.includes(privateRoot))
  if (live.length) {
    throw new Error('Private runtime still has live children')
  }
  writeJSON('final-closed-control-summary.json', {
    source,
    boundary,
    rows,
    ptys,
    children,
    freshPrivateRootMatchingProcesses: live,
    scope:
      'Expected unfixed stock+cleared failure observed once; three controls passed. No product fix or latest-source equivalence claim.'
  })
  console.log(
    JSON.stringify({
      source,
      boundary,
      cases: rows.length,
      expectedFailures: rows.filter((row) => row.expectedFailure).length,
      positivelyExitedPtys: ptys.length
    })
  )
})()
  .catch((error) => {
    writeJSON('failure-disposition.json', {
      source,
      boundary,
      message: error.message,
      rows,
      ptys,
      children,
      qualified: false,
      cleanupVerified: false
    })
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    esbuild.stop()
  })
