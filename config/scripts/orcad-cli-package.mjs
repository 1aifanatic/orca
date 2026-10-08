import { build } from 'esbuild'
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  ORCAD_CLI_ENTRY_FILENAME,
  orcadCliLauncherFilename
} from '../../src/shared/orcad-artifacts.ts'
import { externalNativeAddons } from './orcad-entry-build.mjs'
import { runProcessSync } from './script-child-process.mjs'

export function orcadPosixCliLauncher() {
  return `#!/bin/sh
set -eu
: "\${ORCA_USER_DATA_PATH:?The Orca server data path is required}"
slot=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
runtime_sha=$(cat "$slot/.runtime-node")
case "$runtime_sha" in
  *[!a-f0-9]*|'') echo 'Invalid Orca runtime reference' >&2; exit 78 ;;
esac
[ "\${#runtime_sha}" -eq 64 ] || exit 78
unset NODE_OPTIONS NODE_REPL_EXTERNAL_MODULE
exec "$slot/../runtimes/node-$runtime_sha/bin/node" "$slot/${ORCAD_CLI_ENTRY_FILENAME}" "$@"
`
}

export async function buildOrcadCli(root, outputDir, target) {
  const result = await build({
    entryPoints: [join(root, 'src/cli/index.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: join(outputDir, ORCAD_CLI_ENTRY_FILENAME),
    plugins: [externalNativeAddons],
    metafile: true,
    minify: true,
    sourcemap: false,
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'error'
  })
  const [platform, arch] = target.split('-')
  const launcher = join(outputDir, orcadCliLauncherFilename(platform))
  mkdirSync(dirname(launcher), { recursive: true })
  if (platform === 'win32') {
    const source = join(root, '.build', 'windows-cli-launcher', arch, 'orca.exe')
    if (process.platform === 'win32') {
      const compile = runProcessSync({
        program: process.execPath,
        args: [
          join(root, 'config/scripts/build-windows-cli-launcher.mjs'),
          '--arch',
          arch,
          '--output',
          source
        ],
        stdio: 'inherit',
        timeoutMs: null
      })
      if (compile.code !== 0) {
        throw new Error('Could not build the Orca server CLI launcher')
      }
    }
    copyFileSync(source, launcher)
  } else {
    writeFileSync(launcher, orcadPosixCliLauncher())
    chmodSync(launcher, 0o755)
  }
  return result
}
