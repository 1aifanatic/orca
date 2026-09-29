import { removeHostTree } from '../host-tree-removal'

/**
 * Removes an extracted AppImage payload tree.
 *
 * Why `removeHostTree` and not a plain recursive `rm`: Electron patches `fs` so a `*.asar` file
 * reports `isDirectory() === true`. A recursive remove then tries to `rmdir` a real file, fails
 * with ENOTEMPTY, and strands the ~105 MB `resources/app.asar` of every superseded generation.
 * `removeHostTree` walks with Electron's unpatched fs, so it needs no process-wide `process.noAsar`.
 */
export async function removeExtractedAppImagePayload(targetPath: string): Promise<void> {
  await removeHostTree(targetPath)
}
