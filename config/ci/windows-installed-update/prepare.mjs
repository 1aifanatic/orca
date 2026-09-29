// Bundles the diagnostic tools; importing the driver never launches anything.
// Usage: node prepare.mjs <output-dir>
import { build } from 'esbuild'
import { join, resolve } from 'node:path'

const output = resolve(process.argv[2] ?? '')
const root = resolve(import.meta.dirname, '../../..')
for (const [name, entry, format] of [
  ['run-installed.mjs', join(import.meta.dirname, 'run-installed.mjs'), 'esm'],
  ['qualification-rpc.cjs', join(import.meta.dirname, 'qualification-rpc.ts'), 'cjs'],
  ['daemon-retire.cjs', join(root, 'config/scripts/runtime-serve-smoke-daemon.ts'), 'cjs']
]) {
  await build({
    entryPoints: [entry],
    outfile: join(output, name),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format,
    external: ['electron'],
    logLevel: 'warning'
  })
}
console.log(`Prepared diagnostic tools in ${output}`)
