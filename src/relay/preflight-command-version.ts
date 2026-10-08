import path from 'node:path'
import { runProcess } from '../shared/child-process/run-process'
import { buildRelayCommandEnv } from './relay-command-env'

export async function probeCommandVersion(executablePath: string): Promise<string | null> {
  try {
    const env = buildRelayCommandEnv(process.env, process.platform)
    const pathKey = process.platform === 'win32' && env.Path !== undefined ? 'Path' : 'PATH'
    const executableDir = path.dirname(executablePath)
    const inheritedPath = env[pathKey]
    const result = await runProcess({
      program: executablePath,
      args: ['--version'],
      env: {
        ...env,
        [pathKey]: inheritedPath
          ? `${executableDir}${path.delimiter}${inheritedPath}`
          : executableDir
      },
      timeoutMs: 5_000,
      maxOutputBytes: 4_096
    })
    if (result.code !== 0) {
      return null
    }
    const output = `${result.stdout}\n${result.stderr}`.trim()
    return output.length > 0 ? output : null
  } catch {
    return null
  }
}
