import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runProcessSync } from '../../src/shared/child-process/run-process.ts'
import { resolveCliCommand } from '../../src/shared/node-cli-command-resolution.ts'
import { removeTreeSync } from '../../src/shared/windows-transient-lock-removal.ts'
import { resolvePnpmCliInvocation } from './pnpm-cli-invocation.mjs'
import { copyScriptWithLocalModules } from './script-module-dependencies.mjs'

const sourceScriptPath = fileURLToPath(new URL('./ensure-native-runtime.mjs', import.meta.url))
// The import walk sees `from './x.mjs'` only, so the createRequire'd CJS
// siblings have to be named. Without them the temp project cannot even load.
const REQUIRED_CJS_SIBLINGS = [
  'node-pty-job-ownership.cjs',
  'windows-process-tree-creation-time.cjs'
]

describe('ensure-native-runtime', () => {
  it('rechecks Node native modules in fresh child processes after rebuilding', () => {
    const projectDir = mkTempProject()

    try {
      const scriptPath = join(projectDir, 'config', 'scripts', 'ensure-native-runtime.mjs')
      const logPath = join(projectDir, 'native-runtime.log')
      const markerPath = join(projectDir, 'rebuilt.marker')
      const binDir = join(projectDir, 'bin')
      writeFakeNativeModules(projectDir)
      writeNodePtyPatchFile(projectDir)
      writeFakePnpm(binDir)

      const result = spawnSync(process.execPath, [scriptPath, '--runtime=node'], {
        cwd: projectDir,
        encoding: 'utf8',
        env: envWithPrependedPath(binDir, {
          ORCA_NATIVE_TEST_LOG: logPath,
          ORCA_NATIVE_TEST_MARKER: markerPath
        })
      })

      expect(result.status, result.stderr).toBe(0)
      const log = readFileSync(logPath, 'utf8')
      expect(log).toContain('pnpm --config.verify-deps-before-run=false exec node-gyp rebuild\n')
      expect(log).toContain(join('node_modules', 'node-pty'))
      if (process.platform === 'linux') {
        expect(log).toMatch(/^cxxflags=(?:.*\s)?-std=gnu\+\+2a$/m)
      }
      expect(log.split('\n').filter((line) => line.startsWith('node-pty child '))).toEqual([
        expect.stringMatching(/^node-pty child (?:conpty|pty) marker=false$/),
        expect.stringMatching(/^node-pty child (?:conpty|pty) marker=true$/)
      ])
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'win32')(
    'rebuilds other failed Windows addons with patched node-pty',
    () => {
      const projectDir = mkTempProject()

      try {
        const scriptPath = join(projectDir, 'config', 'scripts', 'ensure-native-runtime.mjs')
        const logPath = join(projectDir, 'native-runtime.log')
        const markerPath = join(projectDir, 'rebuilt.marker')
        const binDir = join(projectDir, 'bin')
        writeFakeNativeModules(projectDir, { windowsRegistryRequiresMarker: true })
        writeNodePtyPatchFile(projectDir)
        writeFakePnpm(binDir)

        const result = spawnSync(process.execPath, [scriptPath, '--runtime=node'], {
          cwd: projectDir,
          encoding: 'utf8',
          env: envWithPrependedPath(binDir, {
            ORCA_NATIVE_TEST_LOG: logPath,
            ORCA_NATIVE_TEST_MARKER: markerPath
          })
        })

        expect(result.status, result.stderr).toBe(0)
        const log = readFileSync(logPath, 'utf8')
        expect(
          log.match(/pnpm --config.verify-deps-before-run=false exec node-gyp rebuild\n/g)
        ).toHaveLength(2)
        expect(log).toContain(join('node_modules', 'node-pty'))
        expect(log).toContain(join('node_modules', '@orca', 'windows-registry'))
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'rebuilds patched node-pty artifacts even when the Node load check passes',
    () => {
      const projectDir = mkTempProject()

      try {
        const scriptPath = join(projectDir, 'config', 'scripts', 'ensure-native-runtime.mjs')
        const logPath = join(projectDir, 'native-runtime.log')
        const markerPath = join(projectDir, 'rebuilt.marker')
        const binDir = join(projectDir, 'bin')
        writeLoadableNativeModules(projectDir)
        writeNodePtyPatchFile(projectDir)
        writeFakePnpm(binDir)

        const result = spawnSync(process.execPath, [scriptPath, '--runtime=node'], {
          cwd: projectDir,
          encoding: 'utf8',
          env: envWithPrependedPath(binDir, {
            ORCA_NATIVE_TEST_LOG: logPath,
            ORCA_NATIVE_TEST_MARKER: markerPath
          })
        })

        expect(result.status, result.stderr).toBe(0)
        expect(result.stderr).toContain(
          'Patched node-pty build artifacts are missing; rebuilding native deps.'
        )
        expect(readFileSync(logPath, 'utf8')).toContain(
          'pnpm --config.verify-deps-before-run=false exec node-gyp rebuild\n'
        )
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'rebuilds when patched artifacts exist but node-pty resolves to prebuilds',
    () => {
      const projectDir = mkTempProject()

      try {
        const scriptPath = join(projectDir, 'config', 'scripts', 'ensure-native-runtime.mjs')
        const logPath = join(projectDir, 'native-runtime.log')
        const markerPath = join(projectDir, 'rebuilt.marker')
        const binDir = join(projectDir, 'bin')
        writeLoadableNativeModules(projectDir)
        writeNodePtyPatchFile(projectDir)
        writePatchedNodePtyBuildArtifacts(projectDir)
        writeFakePnpm(binDir)

        const result = spawnSync(process.execPath, [scriptPath, '--runtime=node'], {
          cwd: projectDir,
          encoding: 'utf8',
          env: envWithPrependedPath(binDir, {
            ORCA_NATIVE_TEST_LOG: logPath,
            ORCA_NATIVE_TEST_MARKER: markerPath
          })
        })

        expect(result.status, result.stderr).toBe(0)
        expect(result.stderr).toContain("expected build/Release so Orca's node-pty patch is active")
        expect(readFileSync(logPath, 'utf8')).toContain(
          'pnpm --config.verify-deps-before-run=false exec node-gyp rebuild\n'
        )
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'keeps the fast path when the platform-specific patched artifacts exist',
    () => {
      const projectDir = mkTempProject()

      try {
        const scriptPath = join(projectDir, 'config', 'scripts', 'ensure-native-runtime.mjs')
        const logPath = join(projectDir, 'native-runtime.log')
        const markerPath = join(projectDir, 'rebuilt.marker')
        const binDir = join(projectDir, 'bin')
        writeLoadableNativeModules(projectDir, { nativeDir: '../build/Release/' })
        writeNodePtyPatchFile(projectDir)
        writePatchedNodePtyBuildArtifacts(projectDir)
        writeFakePnpm(binDir)

        const result = spawnSync(process.execPath, [scriptPath, '--runtime=node'], {
          cwd: projectDir,
          encoding: 'utf8',
          env: envWithPrependedPath(binDir, {
            ORCA_NATIVE_TEST_LOG: logPath,
            ORCA_NATIVE_TEST_MARKER: markerPath
          })
        })

        expect(result.status, result.stderr).toBe(0)
        expect(result.stderr).not.toContain('Patched node-pty build artifacts are missing')
        expect(readFileSync(logPath, 'utf8')).not.toContain('exec node-gyp rebuild')
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
      }
    }
  )
  it('rebuilds through real pnpm without installing addon development dependencies', () => {
    const { command, prefixArgs } = resolvePnpmCliInvocation()
    const program = isAbsolute(command) ? command : resolveCliCommand(parse(command).name)
    expect(isAbsolute(program), 'pnpm must be installed for the native rebuild contract').toBe(true)
    const projectDir = mkTempProject()
    try {
      const binDir = join(projectDir, 'bin')
      const markerPath = join(projectDir, 'rebuilt.marker')
      const logPath = join(projectDir, 'native-runtime.log')
      writeFakeNativeModules(projectDir)
      writeNodePtyPatchFile(projectDir)
      const addonDir = join(projectDir, 'node_modules', 'node-pty')
      const sourceDevDir = join(addonDir, 'source-only-dev')
      mkdirSync(sourceDevDir)
      writeFileSync(
        join(sourceDevDir, 'package.json'),
        '{"name":"source-only-dev","version":"1.0.0"}'
      )
      writeFileSync(
        join(addonDir, 'package.json'),
        JSON.stringify({
          name: 'node-pty',
          version: '1.1.0',
          main: 'index.js',
          devDependencies: { 'source-only-dev': 'file:./source-only-dev' },
          scripts: {
            prepare:
              "node -e \"require('node:fs').writeFileSync('prepare-ran','');process.exit(43)\""
          }
        })
      )
      writePnpmShim(
        binDir,
        `
import(${JSON.stringify(new URL('./script-child-process.mjs', import.meta.url).href)}).then(({ runProcessSync }) => {
  const result = runProcessSync({ program: ${JSON.stringify(program)}, args: [...${JSON.stringify(prefixArgs)}, ...process.argv.slice(2)], cwd: process.cwd(), timeoutMs: 20_000 })
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  process.exit(result.code ?? 1)
}).catch((error) => { console.error(error); process.exit(1) })
`
      )
      const nodeGypScript = join(binDir, 'node-gyp.cjs')
      writeFileSync(
        nodeGypScript,
        `
const { appendFileSync, writeFileSync } = require('node:fs')
appendFileSync(process.env.ORCA_NATIVE_TEST_LOG, 'real-pnpm node-gyp ' + process.argv.slice(2).join(' ') + '\\n')
writeFileSync(process.env.ORCA_NATIVE_TEST_MARKER, 'rebuilt')
`
      )
      const nodeGypPath = join(binDir, 'node-gyp')
      writeFileSync(nodeGypPath, `#!/usr/bin/env node\nrequire(${JSON.stringify(nodeGypScript)})\n`)
      chmodSync(nodeGypPath, 0o755)
      writeFileSync(
        join(binDir, 'node-gyp.cmd'),
        `@echo off\r\n"${process.execPath}" "%~dp0\\node-gyp.cjs" %*\r\n`
      )
      const result = runProcessSync({
        program: process.execPath,
        args: [
          join(projectDir, 'config', 'scripts', 'ensure-native-runtime.mjs'),
          '--runtime=node'
        ],
        cwd: projectDir,
        timeoutMs: 20_000,
        env: envWithPrependedPath(binDir, {
          ORCA_BACKGROUND_LAUNCH: '1',
          ORCA_NATIVE_TEST_LOG: logPath,
          ORCA_NATIVE_TEST_MARKER: markerPath
        })
      })
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0)
      expect(readFileSync(logPath, 'utf8')).toContain('real-pnpm node-gyp rebuild\n')
      expect(existsSync(join(addonDir, 'prepare-ran'))).toBe(false)
      expect(existsSync(join(addonDir, 'pnpm-lock.yaml'))).toBe(false)
      expect(existsSync(join(addonDir, 'node_modules', 'source-only-dev'))).toBe(false)
    } finally {
      removeTreeSync(projectDir)
    }
  })
})

function mkTempProject() {
  const projectDir = mkdtempSync(join(tmpdir(), 'orca-native-runtime-'))
  // Walked, not listed: the script imports windows-process-tree-gyp-rebuild.mjs, and a fixture
  // missing it fails every case with a module-resolution error instead of the defect under test.
  copyScriptWithLocalModules(sourceScriptPath, join(projectDir, 'config', 'scripts'))
  for (const name of REQUIRED_CJS_SIBLINGS) {
    copyFileSync(
      fileURLToPath(new URL(`./${name}`, import.meta.url)),
      join(projectDir, 'config', 'scripts', name)
    )
  }
  return projectDir
}

function envWithPrependedPath(binDir, extraEnv) {
  const pathKey =
    process.platform === 'win32'
      ? (Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'Path')
      : 'PATH'
  return {
    ...process.env,
    ...extraEnv,
    [pathKey]: `${binDir}${delimiter}${process.env[pathKey] ?? ''}`
  }
}

function writeFakeNativeModules(projectDir, { windowsRegistryRequiresMarker = false } = {}) {
  const nodePtyDir = join(projectDir, 'node_modules', 'node-pty')
  mkdirSync(join(nodePtyDir, 'lib'), { recursive: true })
  writeFileSync(
    join(nodePtyDir, 'package.json'),
    '{"name":"node-pty","version":"1.1.0","main":"index.js"}\n'
  )
  mkdirSync(join(nodePtyDir, 'scripts'), { recursive: true })
  writeFileSync(join(nodePtyDir, 'scripts', 'post-install.js'), '')

  writeFileSync(join(nodePtyDir, 'index.js'), 'module.exports = {}\n')
  writeFileSync(
    join(nodePtyDir, 'lib', 'utils.js'),
    `
const { appendFileSync, existsSync } = require('node:fs')

exports.loadNativeModule = function loadNativeModule(nativeName) {
  const markerExists = existsSync(process.env.ORCA_NATIVE_TEST_MARKER)
  appendFileSync(
    process.env.ORCA_NATIVE_TEST_LOG,
    \`node-pty \${process.argv.includes('--check-only') ? 'child' : 'parent'} \${nativeName} marker=\${markerExists}\\n\`
  )
  if (!markerExists) {
    throw new Error('ABI mismatch sentinel')
  }
  return {
    dir: '../build/Release/',
    module: {
      listJobProcessIds() {},
      terminateJob() {},
      assignCurrentProcessToJob() {}
    }
  }
}
`
  )
  writeFakeWindowsRegistry(projectDir, { requiresMarker: windowsRegistryRequiresMarker })
  if (process.platform === 'win32') {
    const buildDir = join(nodePtyDir, 'build', 'Release')
    mkdirSync(buildDir, { recursive: true })
    writeFileSync(join(buildDir, 'conpty.node'), Buffer.from('msys-2.0.dll', 'utf16le'))
  }
}

function writeLoadableNativeModules(projectDir, { nativeDir = null } = {}) {
  const nodePtyDir = join(projectDir, 'node_modules', 'node-pty')
  mkdirSync(join(nodePtyDir, 'lib'), { recursive: true })
  writeFileSync(
    join(nodePtyDir, 'package.json'),
    '{"name":"node-pty","version":"1.1.0","main":"index.js"}\n'
  )
  mkdirSync(join(nodePtyDir, 'scripts'), { recursive: true })
  writeFileSync(join(nodePtyDir, 'scripts', 'post-install.js'), '')

  writeFileSync(join(nodePtyDir, 'index.js'), 'module.exports = {}\n')
  writeFileSync(
    join(nodePtyDir, 'lib', 'utils.js'),
    `
const { appendFileSync, existsSync } = require('node:fs')

exports.loadNativeModule = function loadNativeModule(nativeName) {
  const rebuilt = existsSync(process.env.ORCA_NATIVE_TEST_MARKER)
  const dir = ${JSON.stringify(nativeDir)} ??
    (rebuilt ? '../build/Release/' : '../prebuilds/' + process.platform + '-' + process.arch + '/')
  appendFileSync(process.env.ORCA_NATIVE_TEST_LOG, \`node-pty load \${nativeName} dir=\${dir}\\n\`)
  return {
    dir,
    module: {
      listJobProcessIds: () => [],
      terminateJob: () => true,
      assignCurrentProcessToJob: () => true
    }
  }
}
`
  )
  writeFakeWindowsRegistry(projectDir)
}

function writeFakeWindowsRegistry(projectDir, { requiresMarker = false } = {}) {
  if (process.platform !== 'win32') {
    return
  }
  const registryDir = join(projectDir, 'node_modules', '@orca', 'windows-registry')
  mkdirSync(registryDir, { recursive: true })
  writeFileSync(
    join(registryDir, 'package.json'),
    '{"name":"@orca/windows-registry","version":"1.0.0","main":"index.js"}\n'
  )
  const markerGate = requiresMarker
    ? `if (!require('node:fs').existsSync(process.env.ORCA_NATIVE_TEST_MARKER)) { throw new Error('registry ABI mismatch sentinel') }`
    : ''
  writeFileSync(
    join(registryDir, 'index.js'),
    `exports.HK = { CU: 0x80000001 }; exports.getRegistryKey = () => { ${markerGate}; return {} }\n`
  )
  const processTreeDir = join(projectDir, 'node_modules', '@vscode', 'windows-process-tree')
  mkdirSync(processTreeDir, { recursive: true })
  writeFileSync(
    join(processTreeDir, 'index.js'),
    'exports.supportedProcessDataFlags = 4; exports.getProcessCreationTime = () => 1\n'
  )
}

function writeNodePtyPatchFile(projectDir) {
  mkdirSync(join(projectDir, 'config', 'patches'), { recursive: true })
  writeFileSync(join(projectDir, 'config', 'patches', 'node-pty@1.1.0.patch'), 'patch marker\n')
}

function writePatchedNodePtyBuildArtifacts(projectDir) {
  const buildDir = join(projectDir, 'node_modules', 'node-pty', 'build', 'Release')
  mkdirSync(buildDir, { recursive: true })
  if (process.platform === 'win32') {
    writeFileSync(join(buildDir, 'conpty.node'), '')
    mkdirSync(join(buildDir, 'conpty'), { recursive: true })
    writeFileSync(join(buildDir, 'conpty', 'conpty.dll'), '')
    writeFileSync(join(buildDir, 'conpty', 'OpenConsole.exe'), '')
    return
  }
  writeFileSync(join(buildDir, 'pty.node'), '')
  if (process.platform === 'darwin') {
    writeFileSync(join(buildDir, 'spawn-helper'), '')
  }
}

function writeFakePnpm(binDir) {
  writePnpmShim(
    binDir,
    `
const { appendFileSync, writeFileSync } = require('node:fs')

appendFileSync(process.env.ORCA_NATIVE_TEST_LOG, \`pnpm \${process.argv.slice(2).join(' ')}\\n\`)
appendFileSync(process.env.ORCA_NATIVE_TEST_LOG, \`cwd=\${process.cwd()}\\n\`)
appendFileSync(
  process.env.ORCA_NATIVE_TEST_LOG,
  \`npm_config_build_from_source=\${process.env.npm_config_build_from_source || ''}\\n\`
)
appendFileSync(
  process.env.ORCA_NATIVE_TEST_LOG,
  \`cxxflags=\${process.env.CXXFLAGS || ''}\\n\`
)
writeFileSync(process.env.ORCA_NATIVE_TEST_MARKER, 'rebuilt')
`
  )
}

function writePnpmShim(binDir, source) {
  mkdirSync(binDir, { recursive: true })
  const shimPath = join(binDir, 'pnpm-shim.cjs')
  writeFileSync(shimPath, source)

  const posixPnpmPath = join(binDir, 'pnpm')
  writeFileSync(posixPnpmPath, `#!/usr/bin/env node\nrequire(${JSON.stringify(shimPath)})\n`)
  chmodSync(posixPnpmPath, 0o755)
  writeFileSync(
    join(binDir, 'pnpm.cmd'),
    `@echo off\r\n"${process.execPath}" "%~dp0\\pnpm-shim.cjs" %*\r\n`
  )
}
