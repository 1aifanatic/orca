import { describe, expect, it } from 'vitest'
import type { SparsePreset } from '../../shared/worktree/create-types'
import { attributedSparsePresetId } from './sparse-preset-attribution'

const PRESET: SparsePreset = {
  id: 'preset-1',
  repoId: 'repo-1',
  name: 'web',
  directories: ['apps/web', 'packages/ui'],
  createdAt: 0,
  updatedAt: 0
}

describe('the sparse preset a create is recorded under', () => {
  it('keeps a preset whose directories are exactly the ones checked out, in any order', () => {
    expect(
      attributedSparsePresetId([PRESET], 'repo-1', 'preset-1', ['packages/ui', 'apps/web'])
    ).toBe('preset-1')
  })

  it.each([
    ['an edited selection', 'repo-1', 'preset-1', ['apps/web']],
    ['another repo’s preset', 'repo-2', 'preset-1', ['apps/web', 'packages/ui']],
    ['a preset that no longer exists', 'repo-1', 'preset-gone', ['apps/web', 'packages/ui']],
    ['no preset at all', 'repo-1', undefined, ['apps/web', 'packages/ui']]
  ])('records none for %s', (_case, repoId, presetId, directories) => {
    expect(attributedSparsePresetId([PRESET], repoId, presetId, directories)).toBeUndefined()
  })
})
