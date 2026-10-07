import { writeFileSync } from 'node:fs'
import { inspect } from 'node:util'
import { relative } from 'node:path'

export default class {
  onInit(ctx) { this.ctx = ctx; this.cacheDiagnosticLogs = [] }
  onUserConsoleLog(log) {
    const prefix = 'ORCA_GH_CACHE_DIAGNOSTIC '
    for (const message of log.content.split('\n')) {
      if (message.startsWith(prefix)) this.cacheDiagnosticLogs.push({ type: log.type, taskId: log.taskId, message, rawContent: log.content })
    }
  }
  onTestRunEnd(modules, errors, reason) {
    const root = this.ctx.config.root
    const config = this.ctx.config
    writeFileSync(process.env.ORCA_IMPORT_REUSE_DETAILS, JSON.stringify({
      reason, errors: errors.map(error => inspect(error, { depth: 3 })), rootFsModuleCache: config.fsModuleCache, rootIsolation: config.isolate,
      resolvedRootMaxWorkers: config.maxWorkers,
      projects: this.ctx.projects.map(project => ({
        name: project.name, pool: project.config.pool, fsModuleCache: project.config.fsModuleCache,
        effectiveMaxWorkers: project.config.maxWorkers ?? config.maxWorkers,
        isolate: project.config.isolate, testTimeout: project.config.testTimeout, hookTimeout: project.config.hookTimeout,
        setups: project.config.setupFiles.map(file => relative(root, file).replaceAll('\\', '/')),
        execArgv: project.config.execArgv
      })),
      modules: modules.map(module => ({
        file: relative(root, module.moduleId).replaceAll('\\', '/'),
        project: module.project.name, pool: module.project.config.pool,
        diagnostic: module.diagnostic()
      }))
    }, null, 2) + '\n')
    const path = process.env.ORCA_IMPORT_REUSE_DETAILS
    if (!path.endsWith('-details.json')) throw new Error('Unexpected diagnostic output path')
    writeFileSync(path.slice(0, -'-details.json'.length) + '-cache-events.json', JSON.stringify({ reason, logs: this.cacheDiagnosticLogs }, null, 2) + '\n', { flag: 'wx' })
  }
}
