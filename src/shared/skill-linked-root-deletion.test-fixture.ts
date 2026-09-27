import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Scratch homes shaped like orca#22897, with real symlinks rather than a stubbed `lstat`:
 * the guard's whole answer is what `lstat` reports about a link, so a fake filesystem
 * would test the fake. Shared by the predicate's own suite and the update runner's.
 */

const homes: string[] = []

export async function createLinkedRootHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'orca-linked-root-'))
  homes.push(home)
  await mkdir(join(home, '.agents', 'skills', 'orca-cli'), { recursive: true })
  await writeFile(join(home, '.agents', 'skills', 'orca-cli', 'SKILL.md'), '# canonical\n')
  await mkdir(join(home, 'dotfiles', 'skills'), { recursive: true })
  return home
}

export async function removeLinkedRootHomes(): Promise<void> {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
}

export async function writeRealSkillDirectory(parent: string, name: string): Promise<string> {
  const path = join(parent, name)
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'SKILL.md'), `# ${name}\n`)
  return path
}

/** `<home>/<provider>/skills` linked at the dotfiles tree, the way #22897's reporter has it. */
export async function linkProviderRoot(home: string, provider: string): Promise<string> {
  await mkdir(join(home, provider), { recursive: true })
  await symlink(join(home, 'dotfiles', 'skills'), join(home, provider, 'skills'), 'dir')
  return join(home, provider, 'skills')
}

/** The relative directory symlink Orca places itself; docs/reference/agent-skill-provider-paths.md. */
export async function linkOrcaPlacement(home: string, name: string): Promise<void> {
  await symlink(
    join('..', '..', '.agents', 'skills', name),
    join(home, 'dotfiles', 'skills', name),
    'dir'
  )
}
