import type { SparsePreset } from '../../shared/worktree/create-types'
import { normalizeSparseDirectories } from './sparse-checkout-directories'

/**
 * The preset a sparse create is recorded under: only one of this repo's presets whose directories
 * are exactly the ones checked out, so an edited selection is never shown as the preset it began as.
 */
export function attributedSparsePresetId(
  presets: readonly SparsePreset[],
  repoId: string,
  presetId: string | undefined,
  sparseDirectories: readonly string[]
): string | undefined {
  const preset = presetId ? presets.find((entry) => entry.id === presetId) : undefined
  if (preset?.repoId !== repoId) {
    return undefined
  }
  try {
    const presetDirectories = normalizeSparseDirectories(preset.directories)
    // Set-based so directory order doesn't matter, as the renderer's `sparseDirectoriesMatch` does.
    const presetSet = new Set(presetDirectories)
    const directoriesMatch =
      presetDirectories.length === sparseDirectories.length &&
      sparseDirectories.every((entry) => presetSet.has(entry))
    return directoriesMatch ? preset.id : undefined
  } catch {
    // Corrupt preset data must not block the create or falsely label the new worktree.
    return undefined
  }
}
