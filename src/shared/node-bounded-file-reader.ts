import { closeSync, constants, fstatSync, openSync, readSync, statSync, type Stats } from 'node:fs'
import { open, stat, type FileHandle } from 'node:fs/promises'

const MIN_GROWTH_BYTES = 64 * 1024

export class NodeFileReadTooLargeError extends Error {
  constructor(
    readonly observedBytes: number,
    readonly maxBytes: number
  ) {
    super(
      `File too large: ${(observedBytes / 1024 / 1024).toFixed(1)}MB exceeds ${maxBytes / 1024 / 1024}MB limit`
    )
    this.name = 'NodeFileReadTooLargeError'
  }
}

export type BoundedNodeFileRead = {
  buffer: Buffer
  stats: Stats
}

type NodeFileReadWindow = { offset: number; length?: number }
type NodeFileReadOptions = {
  regularFileOnly?: boolean
  signal?: AbortSignal
  window?: NodeFileReadWindow
}

function captureReadOptions(maxBytes: number, options: NodeFileReadOptions): NodeFileReadOptions {
  const window = options.window ? { ...options.window } : undefined
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('File read limit must be a non-negative safe integer')
  }
  if (
    window &&
    (!Number.isSafeInteger(window.offset) ||
      window.offset < 0 ||
      (window.length !== undefined && (!Number.isSafeInteger(window.length) || window.length < 0)))
  ) {
    throw new RangeError('File read window must contain non-negative safe integers')
  }
  return { ...options, window }
}

function readWindowLength(size: number, maxBytes: number, window: NodeFileReadWindow): number {
  // A window keeps the opened extent; only whole-file reads include later growth.
  validateSize(size, Number.MAX_SAFE_INTEGER)
  const remaining = size - window.offset
  const length = window.length ?? remaining
  if (remaining < 0 || length > remaining) {
    throw new Error('File is smaller than the requested window')
  }
  validateSize(length, maxBytes)
  return length
}

function validateSize(size: number, maxBytes: number): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error('File has an invalid byte size')
  }
  if (size > maxBytes) {
    throw new NodeFileReadTooLargeError(size, maxBytes)
  }
}

export async function readNodeFileWithinLimit(
  filePath: string,
  maxBytes: number,
  options: NodeFileReadOptions = {}
): Promise<BoundedNodeFileRead> {
  const readOptions = captureReadOptions(maxBytes, options)
  readOptions.signal?.throwIfAborted()
  if (readOptions.regularFileOnly && !(await stat(filePath)).isFile()) {
    throw new Error('Expected a regular file')
  }
  readOptions.signal?.throwIfAborted()
  // Nonblocking open fences replacement with a FIFO after the path check.
  const flags = readOptions.regularFileOnly
    ? constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK)
    : 'r'
  const handle = await open(filePath, flags)
  try {
    return await readNodeFileHandleWithinLimit(handle, maxBytes, readOptions)
  } finally {
    await handle.close()
  }
}

export async function readNodeFileHandleWithinLimit(
  handle: FileHandle,
  maxBytes: number,
  options: NodeFileReadOptions = {}
): Promise<BoundedNodeFileRead> {
  const readOptions = captureReadOptions(maxBytes, options)

  readOptions.signal?.throwIfAborted()
  const stats = await handle.stat()
  readOptions.signal?.throwIfAborted()
  if (readOptions.regularFileOnly && !stats.isFile()) {
    throw new Error('Expected a regular file')
  }
  if (readOptions.window) {
    const window = readOptions.window
    const buffer = Buffer.allocUnsafe(readWindowLength(stats.size, maxBytes, window))
    let offset = 0
    while (offset < buffer.length) {
      readOptions.signal?.throwIfAborted()
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        window.offset + offset
      )
      readOptions.signal?.throwIfAborted()
      if (bytesRead === 0) {
        throw new Error('File is smaller than the requested window')
      }
      offset += bytesRead
    }
    return { buffer, stats }
  }
  validateSize(stats.size, maxBytes)

  let buffer = Buffer.allocUnsafe(stats.size)
  let offset = 0
  while (true) {
    readOptions.signal?.throwIfAborted()
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      readOptions.signal?.throwIfAborted()
      if (bytesRead === 0) {
        return { buffer: buffer.subarray(0, offset), stats }
      }
      offset += bytesRead
    }

    const probe = Buffer.allocUnsafe(1)
    const { bytesRead } = await handle.read(probe, 0, 1, offset)
    readOptions.signal?.throwIfAborted()
    if (bytesRead === 0) {
      return { buffer: buffer.subarray(0, offset), stats }
    }
    if (offset >= maxBytes) {
      throw new NodeFileReadTooLargeError(offset + bytesRead, maxBytes)
    }

    // Why: ordinary readFile includes concurrent growth, so retain that behavior while capacity stays bounded.
    const nextCapacity = Math.min(
      maxBytes,
      Math.max(MIN_GROWTH_BYTES, buffer.length * 2, offset + bytesRead)
    )
    const expanded = Buffer.allocUnsafe(nextCapacity)
    buffer.copy(expanded, 0, 0, offset)
    expanded[offset] = probe[0]!
    buffer = expanded
    offset += bytesRead
  }
}

export function readNodeFileSyncWithinLimit(
  filePath: string,
  maxBytes: number,
  options: Omit<NodeFileReadOptions, 'signal'> = {}
): BoundedNodeFileRead {
  const readOptions = captureReadOptions(maxBytes, options)
  if (readOptions.regularFileOnly && !statSync(filePath).isFile()) {
    throw new Error('Expected a regular file')
  }
  const flags = readOptions.regularFileOnly
    ? constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK)
    : 'r'
  const descriptor = openSync(filePath, flags)
  try {
    const stats = fstatSync(descriptor)
    if (readOptions.regularFileOnly && !stats.isFile()) {
      throw new Error('Expected a regular file')
    }
    if (readOptions.window) {
      const window = readOptions.window
      const buffer = Buffer.allocUnsafe(readWindowLength(stats.size, maxBytes, window))
      let offset = 0
      while (offset < buffer.length) {
        const bytesRead = readSync(
          descriptor,
          buffer,
          offset,
          buffer.length - offset,
          window.offset + offset
        )
        if (bytesRead === 0) {
          throw new Error('File is smaller than the requested window')
        }
        offset += bytesRead
      }
      return { buffer, stats }
    }
    validateSize(stats.size, maxBytes)

    let buffer = Buffer.allocUnsafe(stats.size)
    let offset = 0
    while (true) {
      while (offset < buffer.length) {
        const bytesRead = readSync(descriptor, buffer, offset, buffer.length - offset, offset)
        if (bytesRead === 0) {
          return { buffer: buffer.subarray(0, offset), stats }
        }
        offset += bytesRead
      }

      const probe = Buffer.allocUnsafe(1)
      const bytesRead = readSync(descriptor, probe, 0, 1, offset)
      if (bytesRead === 0) {
        return { buffer: buffer.subarray(0, offset), stats }
      }
      if (offset >= maxBytes) {
        throw new NodeFileReadTooLargeError(offset + bytesRead, maxBytes)
      }

      const nextCapacity = Math.min(
        maxBytes,
        Math.max(MIN_GROWTH_BYTES, buffer.length * 2, offset + bytesRead)
      )
      const expanded = Buffer.allocUnsafe(nextCapacity)
      buffer.copy(expanded, 0, 0, offset)
      expanded[offset] = probe[0]!
      buffer = expanded
      offset += bytesRead
    }
  } finally {
    closeSync(descriptor)
  }
}
