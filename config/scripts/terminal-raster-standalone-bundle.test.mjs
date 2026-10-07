import { describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createPatchTestDirectory } from './xterm-patch-test-files.mjs'
import { describeProcessFailure, runProcessSync } from './script-child-process.mjs'

describe('terminal raster standalone host bundle', () => {
  it.each([false, true])(
    'decodes without external codec files or fetch with window=%s',
    async (windowPresent) => {
      const root = resolve('.')
      const directory = await createPatchTestDirectory()
      const output = join(directory, 'raster.cjs')
      const bundle = await build({
        stdin: {
          contents: [
            `export { NodeTerminalRasterBackend } from './src/shared/node-terminal-raster-backend'`,
            `export { releaseTerminalRasterDecoder } from './src/shared/terminal-raster-wasm-decoder'`,
            `export { default as fixtures } from './src/shared/__fixtures__/terminal-raster-red.json'`
          ].join('\n'),
          resolveDir: root,
          sourcefile: 'terminal-raster-entry.ts'
        },
        outfile: output,
        bundle: true,
        platform: 'node',
        target: 'node18',
        format: 'cjs',
        metafile: true,
        logLevel: 'silent'
      })
      expect(
        Object.values(bundle.metafile.outputs)
          .flatMap((value) => value.imports)
          .filter((entry) => !entry.path.startsWith('node:'))
      ).toEqual([])
      const runner = join(directory, 'runner.cjs')
      await writeFile(
        runner,
        [
          'const assert = require("node:assert/strict")',
          'const fs = require("node:fs")',
          'const readFileSync = fs.readFileSync',
          'fs.readFileSync = function(path, ...args) { if (String(path).endsWith(".wasm")) throw new Error("external codec asset read"); return readFileSync.call(this, path, ...args) }',
          'globalThis.fetch = () => { throw new Error("unexpected decoder fetch") }',
          'globalThis.WebAssembly.instantiate = () => { throw new Error("unexpected asynchronous WASM initialization") }',
          ...(windowPresent ? ['globalThis.window = globalThis'] : []),
          'class ExistingImageData { constructor(data, width, height) { this.data = data; this.width = width; this.height = height } }',
          'globalThis.ImageData = ExistingImageData',
          'const { NodeTerminalRasterBackend, releaseTerminalRasterDecoder, fixtures } = require("./raster.cjs")',
          'const backend = new NodeTerminalRasterBackend()',
          'for (const format of ["png", "jpeg", "gif", "webp", "avif"]) { const raster = backend.decode(Buffer.from(fixtures[format], "base64"), "image/" + format, 64); assert.equal(raster.width, 8); assert.equal(raster.height, 8); assert.ok(raster.data[0] >= 245); assert.equal(raster.data[3], 255); raster.close() }',
          'assert.equal(globalThis.ImageData, ExistingImageData)',
          'releaseTerminalRasterDecoder()',
          'console.log("STANDALONE_RASTER_ALL_CODECS_PASS")'
        ].join('\n')
      )
      const result = runProcessSync({
        program: process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath,
        args: [runner],
        cwd: directory,
        env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
        timeoutMs: 30_000
      })
      expect(result.code, describeProcessFailure(result)).toBe(0)
      expect(result.stdout).toContain('STANDALONE_RASTER_ALL_CODECS_PASS')
    }
  )
})
