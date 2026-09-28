// Preparation is explicit and deferred; importing the driver never builds a fixture.
import { build } from 'esbuild'
import { resolve, join } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
for (const [name, entry] of [
  ['daemon-owner-probe', join(import.meta.dirname, 'daemon-owner-probe.ts')],
  ['folder-registration', join(import.meta.dirname, 'folder-registration.ts')],
  ['daemon-cleanup', join(root, 'config/scripts/runtime-serve-smoke-daemon.ts')]
]) {
  await build({ entryPoints: [entry], outfile: join(import.meta.dirname, `${name}.cjs`), bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['electron'] })
}
