import { shell } from 'electron'

// Electron's Linux shell.openPath hands the path to xdg-open without waiting and
// never settles its promise, so an awaiting IPC handler strands its reply.
export const LINUX_OPEN_PATH_SETTLE_BOUND_MS = 1_500

/**
 * shell.openPath that always settles: '' means handed off, otherwise the
 * launcher's error message. On Linux a pending result after the bound is
 * treated as launched because xdg-open has already been spawned.
 */
export function openPathWithSystemDefault(targetPath: string): Promise<string> {
  const opened = shell.openPath(targetPath)
  if (process.platform !== 'linux') {
    return opened
  }
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => resolve(''), LINUX_OPEN_PATH_SETTLE_BOUND_MS)
    opened.then(
      (errorMessage) => {
        clearTimeout(timer)
        resolve(errorMessage)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}
