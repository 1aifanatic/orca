import { writeFileSync } from 'node:fs'
import { relative } from 'node:path'
import { inspect } from 'node:util'

export default class {
  onInit(ctx) { this.ctx = ctx }
  onTestRunEnd(modules, errors, reason) {
    const root = this.ctx.config.root
    const config = this.ctx.config
    writeFileSync(process.env.ORCA_ORIGINAL_ADMISSION_DETAILS, JSON.stringify({
      reason, errors: errors.map(error => inspect(error)),
      rootIsolation: config.isolate, resolvedRootMaxWorkers: config.maxWorkers,
      experimentalFsModuleCache: config.experimental?.fsModuleCache ?? false,
      projects: this.ctx.projects.map(project => ({
        name: project.name, pool: project.config.pool,
        effectiveMaxWorkers: project.config.maxWorkers ?? config.maxWorkers,
        isolate: project.config.isolate, testTimeout: project.config.testTimeout,
        hookTimeout: project.config.hookTimeout,
        experimentalFsModuleCache: project.config.experimental?.fsModuleCache ?? false,
        setups: project.config.setupFiles.map(file => relative(root, file).replaceAll('\\', '/')),
        execArgv: project.config.execArgv
      })),
      modules: modules.map(module => ({
        file: relative(root, module.moduleId).replaceAll('\\', '/'),
        project: module.project.name, pool: module.project.config.pool,
        state: module.state(), diagnostic: module.diagnostic()
      }))
    }, null, 2) + '\n')
  }
}
