import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { boundCodecMemory } from './terminal-raster-codec-memory.mjs'

const require = createRequire(import.meta.url)
const maximumBytes = 128 * 1024 * 1024
const sources = [
  ['png', '@jsquash/png', '3.1.1', 'codec/pkg/squoosh_png_bg.wasm'],
  ['jpeg', '@jsquash/jpeg', '1.6.0', 'codec/dec/mozjpeg_dec.wasm'],
  ['webp', '@jsquash/webp', '1.5.0', 'codec/dec/webp_dec.wasm'],
  ['avif', '@jsquash/avif', '2.1.1', 'codec/dec/avif_dec.wasm']
]
const assets = { maximumBytes, decoders: {} }
for (const [format, packageName, version, source] of sources) {
  const metadata = JSON.parse(readFileSync(require.resolve(`${packageName}/package.json`), 'utf8'))
  if (metadata.version !== version) {
    throw new Error(`Unexpected ${format} decoder version`)
  }
  const original = readFileSync(require.resolve(`${packageName}/${source}`))
  const bounded = boundCodecMemory(original, maximumBytes)
  assets.decoders[format] = {
    version,
    sourceSha256: createHash('sha256').update(original).digest('hex'),
    sha256: createHash('sha256').update(bounded).digest('hex'),
    bytes: bounded.length,
    data: bounded.toString('base64')
  }
}
const target = fileURLToPath(
  new URL('../../src/shared/terminal-raster-codec-assets.json', import.meta.url)
)
const content = `${JSON.stringify(assets, null, 2)}\n`
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== content) {
    throw new Error('Terminal decoder assets are stale')
  }
} else {
  writeFileSync(target, content)
}
console.log(
  `Terminal raster assets verified: ${Object.keys(assets.decoders).length} bounded decoders`
)
