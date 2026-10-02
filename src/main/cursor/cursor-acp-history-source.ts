import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { realpath, readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'

const metadataSchema = z.object({
  schemaVersion: z.literal(1),
  cwd: z.string().min(1).max(4096).refine(isAbsolute)
})

/** ACP stores are separate from Cursor's terminal chats; never substitute one for the other. */
export async function resolveCursorAcpHistorySource(input: {
  accountHomePath: string
  providerSessionId: string
  cwd: string
}): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(input.providerSessionId) || !isAbsolute(input.cwd)) {
    return null
  }
  const directory = join(input.accountHomePath, 'acp-sessions', input.providerSessionId)
  const database = join(directory, 'store.db')
  const metadata = join(directory, 'meta.json')
  try {
    const root = await realpath(join(input.accountHomePath, 'acp-sessions'))
    const ownedDirectory = await realpath(directory)
    if (dirname(ownedDirectory) !== root || basename(ownedDirectory) !== input.providerSessionId) {
      return null
    }
    const [databaseInfo, metadataInfo] = await Promise.all([stat(database), stat(metadata)])
    if (!databaseInfo.isFile() || !metadataInfo.isFile() || metadataInfo.size > 64 * 1024) {
      return null
    }
    if (
      dirname(await realpath(database)) !== ownedDirectory ||
      dirname(await realpath(metadata)) !== ownedDirectory
    ) {
      return null
    }
    const saved = metadataSchema.safeParse(JSON.parse(await readFile(metadata, 'utf8')))
    if (
      !saved.success ||
      normalizeRuntimePathForComparison(resolve(saved.data.cwd)) !==
        normalizeRuntimePathForComparison(resolve(input.cwd))
    ) {
      return null
    }
    return database
  } catch {
    return null
  }
}
