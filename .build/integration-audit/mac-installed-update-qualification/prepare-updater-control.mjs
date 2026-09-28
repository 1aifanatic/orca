import { build } from 'esbuild'
import { join } from 'node:path'
await build({ entryPoints: [join(import.meta.dirname, 'updater-control.ts')], outfile: join(import.meta.dirname, 'updater-control.cjs'), bundle: true, platform: 'node', target: 'node24', format: 'cjs' })
