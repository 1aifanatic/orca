import { inflateSync } from 'node:zlib'
import type { IImageRaster, IImageRasterBackend } from '@xterm/addon-image/src/ImageRasterBackend'
import { readRasterImageDimensions } from './raster-image-dimensions'
import { decodeTerminalGif } from './terminal-raster-gif'
import {
  decodeTerminalWasmImage,
  type TerminalWasmImageFormat
} from './terminal-raster-wasm-decoder'
import {
  checkTerminalRasterSize,
  resizeTerminalRaster,
  translateTerminalRaster,
  TerminalRasterPixels,
  TERMINAL_RASTER_PIXEL_LIMIT
} from './terminal-raster-pixels'

const ENCODED_BYTE_LIMIT = 32 * 1024 * 1024
const INFLATED_BYTE_LIMIT = TERMINAL_RASTER_PIXEL_LIMIT * 4

function formatForMime(mime: string): TerminalWasmImageFormat | 'gif' {
  switch (mime) {
    case 'image/png':
      return 'png'
    case 'image/jpeg':
      return 'jpeg'
    case 'image/webp':
      return 'webp'
    case 'image/avif':
      return 'avif'
    case 'image/gif':
      return 'gif'
    default:
      throw new Error('Unsupported terminal image format')
  }
}

function isDecodedRaster(value: unknown): value is {
  width: number
  height: number
  data: Uint8ClampedArray
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'width' in value &&
    typeof value.width === 'number' &&
    'height' in value &&
    typeof value.height === 'number' &&
    'data' in value &&
    value.data instanceof Uint8ClampedArray
  )
}

export class NodeTerminalRasterBackend implements IImageRasterBackend {
  readonly getCellSize?: IImageRasterBackend['getCellSize']
  readonly getColors?: IImageRasterBackend['getColors']

  constructor(options: Pick<IImageRasterBackend, 'getCellSize' | 'getColors'> = {}) {
    this.getCellSize = options.getCellSize
    this.getColors = options.getColors
  }

  fromRgba(data: Uint8Array | Uint8ClampedArray, width: number, height: number): IImageRaster {
    checkTerminalRasterSize(width, height, TERMINAL_RASTER_PIXEL_LIMIT)
    if (data.byteLength !== width * height * 4) {
      throw new RangeError('Invalid terminal raster pixels')
    }
    return new TerminalRasterPixels(new Uint8ClampedArray(data), width, height)
  }

  decode(data: Uint8Array, mime: string, pixelLimit: number): IImageRaster {
    checkTerminalRasterSize(1, 1, pixelLimit)
    const format = formatForMime(mime)
    if (data.byteLength === 0 || data.byteLength > ENCODED_BYTE_LIMIT) {
      throw new RangeError('Invalid terminal image byte length')
    }
    const ownedBytes = new Uint8Array(data)
    const dimensions = readRasterImageDimensions(ownedBytes)
    if (dimensions) {
      checkTerminalRasterSize(dimensions.width, dimensions.height, pixelLimit)
    } else if (format !== 'avif') {
      throw new Error('Invalid terminal image header')
    }
    let raster: IImageRaster | undefined
    const accept = (decoded: unknown): void => {
      if (!isDecodedRaster(decoded)) {
        throw new Error('Invalid terminal image decoder result')
      }
      checkTerminalRasterSize(decoded.width, decoded.height, pixelLimit)
      raster = this.fromRgba(decoded.data, decoded.width, decoded.height)
    }
    if (format === 'gif') {
      accept(decodeTerminalGif(ownedBytes))
    } else {
      decodeTerminalWasmImage(ownedBytes, format, accept)
    }
    if (!raster) {
      throw new Error('Terminal image decoder returned no raster')
    }
    return raster
  }

  inflate(data: Uint8Array, byteLimit: number): Uint8Array {
    if (
      !Number.isSafeInteger(byteLimit) ||
      byteLimit <= 0 ||
      byteLimit > INFLATED_BYTE_LIMIT ||
      data.byteLength > ENCODED_BYTE_LIMIT
    ) {
      throw new RangeError('Invalid terminal inflate limit')
    }
    return inflateSync(data, { maxOutputLength: byteLimit })
  }

  crop(source: IImageRaster, x: number, y: number, width: number, height: number): IImageRaster {
    return translateTerminalRaster(source, -x, -y, width, height)
  }

  resize(source: IImageRaster, width: number, height: number): IImageRaster {
    return resizeTerminalRaster(source, width, height)
  }

  offset(source: IImageRaster, x: number, y: number, width: number, height: number): IImageRaster {
    return translateTerminalRaster(source, x, y, width, height)
  }
}
