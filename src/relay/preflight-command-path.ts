import path, { win32 } from 'node:path'

export const AGENT_PATH_PREFIX = '__ORCA_AGENT_PATH__'

export function getAbsoluteCommandPath(output: string, platform: NodeJS.Platform): string | null {
  const pathOps = platform === 'win32' ? win32 : path
  return (
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .map((line) => {
        const resolvedPath =
          platform === 'win32'
            ? line
            : line.startsWith(AGENT_PATH_PREFIX)
              ? line.slice(AGENT_PATH_PREFIX.length)
              : ''
        return pathOps.isAbsolute(resolvedPath) ? resolvedPath : null
      })
      .find((resolvedPath): resolvedPath is string => resolvedPath !== null) ?? null
  )
}
