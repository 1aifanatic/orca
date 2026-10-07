const PAGE_BYTES = 65_536

function encodeUnsigned(value) {
  const bytes = []
  do {
    const byte = value % 128
    value = Math.floor(value / 128)
    bytes.push(value ? byte | 128 : byte)
  } while (value)
  return Buffer.from(bytes)
}

export function boundCodecMemory(input, maximumBytes) {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < PAGE_BYTES ||
    maximumBytes % PAGE_BYTES
  ) {
    throw new RangeError('Codec memory limit must be whole WASM pages')
  }
  const maximumPages = maximumBytes / PAGE_BYTES
  const bytes = Buffer.from(input)
  if (!bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) {
    throw new Error('Invalid codec WASM header')
  }
  let offset = 8
  const parts = [bytes.subarray(0, 8)]
  let memorySeen = false
  function readUnsigned(end) {
    let value = 0
    let factor = 1
    for (let count = 0; count < 5 && offset < end; count++) {
      const byte = bytes[offset++]
      value += (byte & 127) * factor
      if (!(byte & 128)) {
        if (value > 0xffffffff) {
          throw new Error('Codec WASM integer overflow')
        }
        return value
      }
      factor *= 128
    }
    throw new Error('Truncated codec WASM integer')
  }
  while (offset < bytes.length) {
    const section = bytes[offset++]
    const length = readUnsigned(bytes.length)
    const end = offset + length
    if (end > bytes.length) {
      throw new Error('Truncated codec WASM section')
    }
    let payload = bytes.subarray(offset, end)
    if (section === 5) {
      if (memorySeen) {
        throw new Error('Duplicate codec memory section')
      }
      memorySeen = true
      const count = readUnsigned(end)
      const flags = readUnsigned(end)
      const initial = readUnsigned(end)
      const originalMaximum = flags & 1 ? readUnsigned(end) : 65_536
      if (count !== 1 || flags > 1 || offset !== end || initial > maximumPages) {
        throw new Error('Unsupported codec memory layout')
      }
      payload = Buffer.concat([
        encodeUnsigned(1),
        encodeUnsigned(1),
        encodeUnsigned(initial),
        encodeUnsigned(Math.min(originalMaximum, maximumPages))
      ])
    }
    parts.push(Buffer.from([section]), encodeUnsigned(payload.length), payload)
    offset = end
  }
  if (!memorySeen) {
    throw new Error('Codec has no defined memory')
  }
  const bounded = Buffer.concat(parts)
  const module = new WebAssembly.Module(bounded)
  if (WebAssembly.Module.imports(module).some((entry) => entry.kind === 'memory')) {
    throw new Error('Codec must own its bounded memory')
  }
  if (WebAssembly.Module.exports(module).filter((entry) => entry.kind === 'memory').length !== 1) {
    throw new Error('Codec must expose exactly one memory')
  }
  return bounded
}
