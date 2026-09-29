// Why: Electron patches `fs` so a `*.asar` file reports `isDirectory() === true` and lists the
// archive's contents, so a tree delete descends into the archive, tries to `rmdir` a real file, and
// fails the parent with ENOTEMPTY. Every worktree that has ever run `pnpm install` carries at least
// one (`node_modules/.pnpm/electron@…/…/Electron.app/Contents/Resources/default_app.asar`), so a
// worktree removal aborts there deterministically — the residue is not a concurrent-writer race and
// no amount of retrying clears it. `original-fs` is Electron's unpatched `fs`; unlike
// `process.noAsar` it is scoped to these calls rather than to the whole process, which matters
// because a multi-GB removal runs for seconds while the main process may still be loading modules
// out of `app.asar`.

import * as nodeFsPromises from 'node:fs/promises'
import { createRequire } from 'node:module'

export type AsarTransparentFs = Pick<
  typeof nodeFsPromises,
  'lstat' | 'readdir' | 'rm' | 'rmdir' | 'unlink'
>

let resolved: AsarTransparentFs | undefined

function resolveFs(): AsarTransparentFs {
  try {
    // Why require and not an import: `original-fs` only exists inside Electron (main and the
    // run-as-node daemon), so vitest, the `orca` CLI, plain-node entrypoints and Bun must resolve
    // `node:fs/promises` instead — and there the shim does not exist, so plain `fs` already is.
    const originalFs: { promises?: AsarTransparentFs } = createRequire(__filename)('original-fs')
    return originalFs.promises ?? nodeFsPromises
  } catch {
    return nodeFsPromises
  }
}

/** `fs.promises` calls that see a `*.asar` as the file it is rather than as a directory. */
export function asarTransparentFs(): AsarTransparentFs {
  resolved ??= resolveFs()
  return resolved
}
