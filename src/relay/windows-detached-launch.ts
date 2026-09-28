import { createRequire } from 'node:module'

type BunFfi = {
  dlopen<T>(
    name: string,
    symbols: Record<string, { args: readonly string[]; returns: string }>
  ): {
    symbols: T
  }
  ptr(view: ArrayBufferView): number | bigint
}

type Kernel32 = {
  CreateProcessW(
    application: number | bigint,
    commandLine: number | bigint,
    processAttributes: null,
    threadAttributes: null,
    inheritHandles: number,
    flags: number,
    environment: null,
    currentDirectory: number | bigint,
    startupInfo: number | bigint,
    processInfo: number | bigint
  ): number
  CloseHandle(handle: number | bigint): number
}

const requireFromRelay = createRequire(__filename)
const CREATE_BREAKAWAY_FROM_JOB = 0x01000000
const CREATE_NO_WINDOW = 0x08000000

function wide(value: string): Uint16Array {
  const encoded = new Uint16Array(value.length + 1)
  for (let index = 0; index < value.length; index += 1) {
    encoded[index] = value.charCodeAt(index)
  }
  return encoded
}

function quoteWindowsArgument(value: string): string {
  if (/^[^\s"]+$/.test(value)) {
    return value
  }
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`
}

export function launchDetachedWindowsRelay(
  executable: string,
  args: readonly string[],
  cwd: string
): number {
  if (process.platform !== 'win32') {
    throw new Error('Windows detached launch is unavailable')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Bun exposes the declared bun:ffi ABI.
  const ffi = requireFromRelay('bun:ffi') as BunFfi
  const kernel = ffi.dlopen<Kernel32>('kernel32.dll', {
    CreateProcessW: {
      args: ['ptr', 'ptr', 'ptr', 'ptr', 'i32', 'u32', 'ptr', 'ptr', 'ptr', 'ptr'],
      returns: 'i32'
    },
    CloseHandle: { args: ['ptr'], returns: 'i32' }
  })
  const application = wide(executable)
  const commandLine = wide([executable, ...args].map(quoteWindowsArgument).join(' '))
  const directory = wide(cwd)
  const startup = new Uint8Array(104)
  new DataView(startup.buffer).setUint32(0, startup.byteLength, true)
  const processInfo = new Uint8Array(24)
  const symbols = kernel.symbols
  const created = symbols.CreateProcessW(
    ffi.ptr(application),
    ffi.ptr(commandLine),
    null,
    null,
    0,
    CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW,
    null,
    ffi.ptr(directory),
    ffi.ptr(startup),
    ffi.ptr(processInfo)
  )
  if (!created) {
    throw new Error('CreateProcessW failed')
  }
  const view = new DataView(processInfo.buffer)
  const process = view.getBigUint64(0, true)
  const thread = view.getBigUint64(8, true)
  symbols.CloseHandle(thread)
  symbols.CloseHandle(process)
  return view.getUint32(16, true)
}
