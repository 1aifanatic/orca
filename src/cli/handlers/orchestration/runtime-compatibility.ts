import { RuntimeClientError } from '../../runtime-client'
import { win32 } from 'node:path'
import { ORCA_CLI_OWNING_HOST_ENV } from '../../../shared/cli-execution-host-env'

export function resolveCompatibilityCliCommand(): 'orca' | 'orca-ide' | 'orca-dev' {
  const configured = process.env.ORCA_CLI_COMMAND
  if (configured === 'orca' || configured === 'orca-ide' || configured === 'orca-dev') {
    return configured
  }
  return process.platform === 'linux' ? 'orca-ide' : 'orca'
}

export function resolvePackagedWindowsCompatibilityCommand(): 'orca' | 'orca-ide' | undefined {
  if (process.env.ORCA_WINDOWS_PACKAGED_CLI_LAUNCHER !== '1') {
    return undefined
  }
  const command = process.env.ORCA_CLI_COMMAND
  if (command === 'orca' || command === 'orca-ide') {
    return command
  }
  if (process.env[ORCA_CLI_OWNING_HOST_ENV] === '1' && command && win32.isAbsolute(command)) {
    return undefined
  }
  throw new RuntimeClientError(
    'invalid_argument',
    'The packaged Orca launcher did not provide a valid resume command. No question was created.'
  )
}

export async function flushOrchestrationStdout(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write('', (error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
}

export function isDevCliInvocation(): boolean {
  return (
    process.env.ORCA_DEV_CLI_INVOCATION === '1' ||
    (process.env.ORCA_USER_DATA_PATH?.includes('orca-dev') ?? false)
  )
}
