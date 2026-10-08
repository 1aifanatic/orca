import { readFile, realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'

const Package = z.object({ name: z.literal('@openai/codex') })

export type CodexNpmInstallationLayout =
  | { kind: 'global'; packageRoot: string; prefix: string }
  | { kind: 'managed'; packageRoot: string }

/** A package name proves identity; layout and its published launcher prove a global prefix. */
export async function readCodexNpmInstallationLayout(
  packagePaths: readonly string[],
  program: string,
  platform: NodeJS.Platform = process.platform
): Promise<CodexNpmInstallationLayout | null> {
  for (const file of packagePaths) {
    try {
      const canonical = await realpath(file)
      if (!Package.safeParse(JSON.parse(await readFile(canonical, 'utf8'))).success) {
        continue
      }
      const packageRoot = dirname(canonical)
      const scope = dirname(packageRoot)
      const modules = dirname(scope)
      const parent = dirname(modules)
      const prefix = platform === 'win32' ? parent : dirname(parent)
      const globalLauncher = join(
        prefix,
        ...(platform === 'win32' ? ['codex.cmd'] : ['bin', 'codex'])
      )
      const globalLayout =
        basename(packageRoot) === 'codex' &&
        basename(scope) === '@openai' &&
        basename(modules) === 'node_modules' &&
        (platform === 'win32' || basename(parent) === 'lib')
      const selected = await realpath(program).catch(() => null)
      const published = await realpath(globalLauncher).catch(() => null)
      return globalLayout && selected !== null && selected === published
        ? { kind: 'global', packageRoot, prefix }
        : { kind: 'managed', packageRoot }
    } catch {
      // Unreadable metadata cannot prove an installation layout.
    }
  }
  return null
}
