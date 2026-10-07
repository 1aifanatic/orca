import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const root = join(dirname(require.resolve('@xterm/xterm/package.json')), 'src')

async function rendererClass(packageName, filename, exportName) {
  const source = join(dirname(require.resolve(`${packageName}/package.json`)), 'src', filename)
  const result = await build({
    entryPoints: [source],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    alias: { common: join(root, 'common'), browser: join(root, 'browser') },
    tsconfigRaw: {
      compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false }
    }
  })
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
  )
  return module[exportName]
}

describe('image provider removal during renderer teardown', () => {
  it.each([
    ['@xterm/xterm', 'browser/renderer/dom/DomRenderer.ts', 'DomRenderer'],
    ['@xterm/addon-webgl', 'WebglRenderer.ts', 'WebglRenderer']
  ])(
    '%s ignores changes after disposal and still refreshes a live renderer',
    async (packageName, filename, name) => {
      const Renderer = await rendererClass(packageName, filename, name)
      expect(() =>
        Renderer.prototype.setImageLayerProvider.call({ _store: { isDisposed: true } }, undefined)
      ).not.toThrow()
      const renderer = {
        _store: { isDisposed: false },
        _rowFactory: {},
        _selectionContainer: { style: {} },
        _bufferService: { rows: 10 },
        _imageRenderer: { clear: vi.fn() },
        _clearModel: vi.fn(),
        _requestRedrawViewport: vi.fn(),
        renderRows: vi.fn()
      }
      Renderer.prototype.setImageLayerProvider.call(renderer, undefined)
      if (name === 'DomRenderer') {
        expect(renderer.renderRows).toHaveBeenCalledWith(0, 9)
      } else {
        expect(renderer._clearModel).toHaveBeenCalledWith(true)
        expect(renderer._requestRedrawViewport).toHaveBeenCalledOnce()
      }
    }
  )
})
