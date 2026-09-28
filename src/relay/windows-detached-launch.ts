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
  CreateFileW(
    path: number | bigint,
    access: number,
    share: number,
    security: null,
    creation: number,
    flags: number,
    template: null
  ): number | bigint
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
const STARTF_USESTDHANDLES = 0x100
const GENERIC_WRITE = 0x40000000
const FILE_SHARE_READ = 1
const CREATE_ALWAYS = 2
const FILE_ATTRIBUTE_NORMAL = 0x80

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
  cwd: string,
  stdoutPath?: string,
  stderrPath?: string
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
    CreateFileW: { args: ['ptr', 'u32', 'u32', 'ptr', 'u32', 'u32', 'ptr'], returns: 'ptr' },
    CloseHandle: { args: ['ptr'], returns: 'i32' }
  })
  const application = wide(executable)
  const commandLine = wide([executable, ...args].map(quoteWindowsArgument).join(' '))
  const directory = wide(cwd)
  const startup = new Uint8Array(104)
  const startupView = new DataView(startup.buffer)
  startupView.setUint32(0, startup.byteLength, true)
  const processInfo = new Uint8Array(24)
  const symbols = kernel.symbols
  const output = stdoutPath
    ? symbols.CreateFileW(
        ffi.ptr(wide(stdoutPath)),
        GENERIC_WRITE,
        FILE_SHARE_READ,
        null,
        CREATE_ALWAYS,
        FILE_ATTRIBUTE_NORMAL,
        null
      )
    : null
  const error = stderrPath
    ? symbols.CreateFileW(
        ffi.ptr(wide(stderrPath)),
        GENERIC_WRITE,
        FILE_SHARE_READ,
        null,
        CREATE_ALWAYS,
        FILE_ATTRIBUTE_NORMAL,
        null
      )
    : null
  if (stdoutPath && BigInt(output as number | bigint) === BigInt('18446744073709551615')) {
    throw new Error('stdout log open failed')
  }
  if (stderrPath && BigInt(error as number | bigint) === BigInt('18446744073709551615')) {
    throw new Error('stderr log open failed')
  }
  if (output !== null || error !== null) {
    startupView.setUint32(60, STARTF_USESTDHANDLES, true)
    if (output !== null) {
      startupView.setBigUint64(88, BigInt(output as number | bigint), true)
    }
    if (error !== null) {
      startupView.setBigUint64(96, BigInt(error as number | bigint), true)
    }
  }
  const created = symbols.CreateProcessW(
    ffi.ptr(application),
    ffi.ptr(commandLine),
    null,
    null,
    output !== null || error !== null ? 1 : 0,
    CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW,
    null,
    ffi.ptr(directory),
    ffi.ptr(startup),
    ffi.ptr(processInfo)
  )
  if (!created) {
    if (output !== null) {
      symbols.CloseHandle(output)
    }
    if (error !== null) {
      symbols.CloseHandle(error)
    }
    throw new Error('CreateProcessW failed')
  }
  const view = new DataView(processInfo.buffer)
  const process = view.getBigUint64(0, true)
  const thread = view.getBigUint64(8, true)
  if (output !== null) {
    symbols.CloseHandle(output)
  }
  if (error !== null) {
    symbols.CloseHandle(error)
  }
  symbols.CloseHandle(thread)
  symbols.CloseHandle(process)
  return view.getUint32(16, true)
}
