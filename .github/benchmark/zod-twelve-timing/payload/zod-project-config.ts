import { isAbsolute, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from '../../../../../config/vitest.config'

export function zodProjectConfig(enabled: boolean) {
  const cacheRoot = process.env.ORCA_ZOD_OPTIMIZER_CACHE
  if (!cacheRoot || !isAbsolute(cacheRoot)) {
    throw new Error('Provide an absolute task-owned optimizer cache root')
  }
  if (!Array.isArray(base.test?.projects)) throw new Error('Expected inline runtime projects')
  const optimizer = {
    ssr: { enabled, include: ['zod', 'zod/v4', 'zod/v4/core'] },
    client: { enabled, include: ['zod', 'zod/v4', 'zod/v4/core'] }
  }
  const identity =
    'notes/bun-migration/performance/zod-dependency-optimizer-proposal/30bc964e-inline-output-twelve-consumer-held-timing-draft/zod-public-binding.fixture.test.ts'
  return defineConfig({
    ...base,
    test: {
      ...base.test,
      projects: base.test.projects.map((project) => {
        if (!project || typeof project !== 'object' || !('test' in project)) {
          throw new Error('Expected inline runtime project')
        }
        const name = project.test?.name
        if (typeof name !== 'string') throw new Error('Expected named runtime project')
        if (name === 'node-runtime' || name === 'node-measurement') return project
        if (name !== 'bun' && name !== 'node') throw new Error(`Unknown ordinary project ${name}`)
        const projectCacheDir = resolve(cacheRoot, name)
        const normalizedCacheDir = projectCacheDir.replaceAll('\\', '/')
        const escapedCacheDir = normalizedCacheDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const generatedOutputs = new RegExp(
          `^${escapedCacheDir}/vitest/[^/]+/deps(?:_ssr)?/[^/]+\\.js(?:\\?.*)?$`
        )
        const inheritedInline = project.test.server?.deps?.inline
        if (!Array.isArray(inheritedInline) || !inheritedInline.includes('zod')) {
          throw new Error('Expected the stock explicit Zod inline rule')
        }
        return {
          ...project,
          cacheDir: projectCacheDir,
          test: {
            ...project.test,
            include: [...(project.test.include ?? []), identity],
            deps: { ...project.test.deps, optimizer },
            server: {
              ...project.test.server,
              deps: {
                ...project.test.server?.deps,
                inline: enabled ? [...inheritedInline, generatedOutputs] : inheritedInline
              }
            }
          }
        }
      })
    }
  })
}
