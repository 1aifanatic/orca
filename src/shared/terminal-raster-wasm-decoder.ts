import jpegFactory from '@jsquash/jpeg/codec/dec/mozjpeg_dec'
import webpFactory from '@jsquash/webp/codec/dec/webp_dec'
import avifFactory from '@jsquash/avif/codec/dec/avif_dec'
import { decode as decodePng, initSync, releaseDecoder } from '@jsquash/png/codec/pkg/squoosh_png'
import type { DecoderModuleOptions } from '@jsquash/jpeg/codec/dec/mozjpeg_dec'
import assets from './terminal-raster-codec-assets.json'

export type TerminalWasmImageFormat = keyof typeof assets.decoders
type Decoder = {
  format: TerminalWasmImageFormat
  memory: WebAssembly.Memory
  decode: (data: Uint8Array<ArrayBuffer>) => unknown
}
const modules = new Map<TerminalWasmImageFormat, WebAssembly.Module>()
const RETAINED_HEAP_LIMIT = 32 * 1024 * 1024
let active: Decoder | undefined

function compiledModule(format: TerminalWasmImageFormat): WebAssembly.Module {
  let module = modules.get(format)
  if (!module) {
    module = new WebAssembly.Module(Buffer.from(assets.decoders[format].data, 'base64'))
    modules.set(format, module)
  }
  return module
}

export function releaseTerminalRasterDecoder(): void {
  if (active?.format === 'png') {
    releaseDecoder()
  }
  active = undefined
}

export function getTerminalRasterDecoderState(): {
  format: TerminalWasmImageFormat | undefined
  memoryBytes: number
  maximumBytes: number
} {
  return {
    format: active?.format,
    memoryBytes: active?.memory.buffer.byteLength ?? 0,
    maximumBytes: assets.maximumBytes
  }
}

function createDecoder(format: TerminalWasmImageFormat): Decoder {
  const module = compiledModule(format)
  if (format === 'png') {
    try {
      const initialized = initSync(module)
      return { format, memory: initialized.memory, decode: decodePng }
    } catch (error) {
      releaseDecoder()
      throw error
    }
  }
  let memory: WebAssembly.Memory | undefined
  const options: DecoderModuleOptions = {
    noInitialRun: true,
    printErr: () => {},
    instantiateWasm(imports, callback) {
      const instance = new WebAssembly.Instance(module, imports)
      memory = Object.values(instance.exports).find((value) => value instanceof WebAssembly.Memory)
      callback(instance)
      return instance.exports
    }
  }
  const factory = format === 'jpeg' ? jpegFactory : format === 'webp' ? webpFactory : avifFactory
  const ready = factory(options)
  let decoder: Decoder | undefined
  void ready.catch(() => {
    if (decoder && active === decoder) {
      releaseTerminalRasterDecoder()
    }
  })
  if (!memory || !('decode' in options) || typeof options.decode !== 'function') {
    throw new Error('Terminal raster decoder initialization was not synchronous')
  }
  const decode = options.decode
  decoder = {
    format,
    memory,
    decode: (data) =>
      format === 'jpeg' ? decode(data, true) : format === 'avif' ? decode(data, 8) : decode(data)
  }
  return decoder
}

export function decodeTerminalWasmImage(
  data: Uint8Array<ArrayBuffer>,
  format: TerminalWasmImageFormat,
  accept: (decoded: unknown) => void
): void {
  if (active?.format !== format) {
    releaseTerminalRasterDecoder()
    active = createDecoder(format)
  }
  const decoder = active
  if (!decoder) {
    throw new Error('Terminal raster decoder unavailable')
  }
  try {
    accept(decoder.decode(data))
  } catch (error) {
    releaseTerminalRasterDecoder()
    throw error
  } finally {
    if (decoder.memory.buffer.byteLength > RETAINED_HEAP_LIMIT) {
      releaseTerminalRasterDecoder()
    }
  }
}
