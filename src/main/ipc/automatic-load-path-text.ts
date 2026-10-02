import { basename, sep } from 'node:path'
import { parseWslUncPath } from '../../shared/wsl-paths'

// Why the path flavour, not the OS: these are Windows path rules, and tests exercise them with
// path.win32 on any host.
function usesWindowsPaths(): boolean {
  return sep === '\\'
}

const WINDOWS_RESERVED_DEVICE_STEM = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i

/** `NUL.png`, `com1 .jpg`, `Aux.` name a Windows device, not a file, whatever the extension. */
export function isWindowsReservedDeviceName(filePath: string): boolean {
  if (!usesWindowsPaths()) {
    return false
  }
  const stem =
    basename(filePath)
      .replace(/[. ]+$/, '')
      .split('.')[0] ?? ''
  return WINDOWS_RESERVED_DEVICE_STEM.test(stem.replace(/ +$/, ''))
}

/**
 * A network share (`\\host\share`) or device namespace (`\\?\`, `\\.\`) path. WSL paths are UNC in
 * form but stay on this machine, so they are not network paths.
 */
export function isNetworkOrDeviceNamespacePath(filePath: string): boolean {
  if (!usesWindowsPaths()) {
    return false
  }
  const normalized = filePath.replace(/\//g, '\\')
  if (!normalized.startsWith('\\\\')) {
    return false
  }
  if (/^\\\\[?.]\\/.test(normalized)) {
    return true
  }
  return parseWslUncPath(normalized) === null
}
