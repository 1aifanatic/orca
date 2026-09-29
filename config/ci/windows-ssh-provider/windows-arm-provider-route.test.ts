import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'

// Only Electron artifact discovery is substituted; SSH/deployment/leases stay real.
vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), getPath: () => process.env.ORCA_SSH_PROBE_STATE }
}))
import { ORCAD_BUN_RELEASE_ASSETS } from '../../shared/orcad-bun-runtime'
import { setAppEnvironment } from '../../shared/app-environment'
import { SshConnection } from './ssh-connection'
import { decodeRemotePowerShellScript, powerShellCommand } from './ssh-remote-powershell'
import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { readWindowsProcessTableFresh } from '../windows/windows-process-table'
import { installCandidateOverride } from './windows-provider-candidate'
import { proveRepaint } from './windows-provider-repaint'
import { inspectProviderImages } from './windows-provider-loaded-images'
import { RELAY_WINDOWS_CONPTY_FILENAMES } from '../../shared/relay-artifacts'

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid RPC object')
  return Object.fromEntries(Object.entries(value))
}
function textField(value: Record<string, unknown>, key: string): string {
  const text = value[key]
  if (typeof text !== 'string' || !text) throw new Error(`Missing ${key}`)
  return text
}
function diagnosticErrorText(output: string): string {
  const serialized = [...output.matchAll(/<S\b[^>]*\bS="Error"[^>]*>([^<]*)<\/S>/gu)]
  const text = output.trimStart().startsWith('#< CLIXML')
    ? serialized
        .map((match) =>
          match[1]
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&amp;/g, '&')
            .replace(/_x([0-9a-f]{4})_/gi, (_, hex: string) =>
              String.fromCharCode(Number.parseInt(hex, 16))
            )
        )
        .join('')
    : output
  // PowerShell source/location echoes contain command text, not failure evidence.
  return text
    .replace(/^[ \t]*\+[ \t]*(CategoryInfo|FullyQualifiedErrorId)[ \t]*:/gmu, '$1:')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:\+|At (?:line:|.+:line\s))/u.test(line))
    .join('\n')
}
function structuredCimFailure(output: string): Record<string, unknown> {
  const identifiers = [
    'MI RESULT 2',
    'MI RESULT 5',
    'MI RESULT 6',
    'MI RESULT 7',
    'HRESULT 0x80070005',
    'HRESULT 0x80041003',
    'AccessDenied',
    'PermissionDenied'
  ] as const
  const identifier =
    /^\s*FullyQualifiedErrorId\s*:\s*([^,\r\n]+),Microsoft\.Management\.Infrastructure\.CimCmdlets\.InvokeCimMethodCommand\s*$/mu.exec(
      output
    )?.[1]
  const category =
    /^\s*CategoryInfo\s*:\s*(PermissionDenied|NotSpecified|InvalidOperation|ResourceUnavailable|ObjectNotFound)\s*:/mu.exec(
      output
    )?.[1]
  const identifierHresult = /^HRESULT (0x[0-9a-f]{8})$/iu.exec(identifier ?? '')?.[1]
  const codes: Record<string, number> = identifierHresult
    ? { hresult: Number(identifierHresult) }
    : {}
  for (const match of output.matchAll(
    /\b(HResult|NativeErrorCode|ErrorCode)\s*[:=]\s*(0x[0-9a-f]{1,8}|-?\d{1,10})(?![\da-z])/giu
  )) {
    const key =
      match[1].toLowerCase() === 'hresult'
        ? 'hresult'
        : match[1].toLowerCase() === 'nativeerrorcode'
          ? 'nativeErrorCode'
          : 'errorCode'
    codes[key] = Number(match[2])
  }
  return {
    ...(identifier && identifiers.some((known) => known === identifier)
      ? { cimErrorId: identifier }
      : {}),
    ...(category ? { powerShellCategory: category } : {}),
    ...codes
  }
}
function classifyFailure(error: unknown): Record<string, unknown> {
  const message = error instanceof Error && error.message.length <= 262144 ? error.message : ''
  // execCommand includes the command before the output; never classify that script as an error.
  const commandFailure = /^Command "([\s\S]*)" failed \(exit (-?\d{1,10})\): ([\s\S]*)$/.exec(
    message
  )
  const output = diagnosticErrorText(
    (commandFailure?.[3] ?? (message.startsWith('Command "') ? '' : message)).slice(0, 16384)
  )
  let command = ''
  try {
    command = decodeRemotePowerShellScript(commandFailure?.[1] ?? '')
  } catch {
    /* Malformed diagnostics have no command phase. */
  }
  const wmiCreateFailure = /Win32_Process\.Create failed with (\d{1,10})/.exec(output)
  const commandPhase =
    command.includes('--spawn-detached') || command.includes('--detached')
      ? 'detached-launch'
      : command.includes('--connect')
        ? 'relay-connect'
        : command.includes('--version')
          ? 'runtime-version'
          : commandFailure
            ? 'remote-command'
            : undefined
  const categories = [
    ['sftp', /sftp|subsystem/i],
    ['permission', /permission|access(?: is)? denied|EACCES|EPERM/i],
    ['missing-file', /not.found|ENOENT|missing/i],
    ['timeout', /timed?.?out|timeout/i],
    ['runtime', /bun|runtime/i],
    ['integrity', /hash|sha256|integrity/i],
    ['connection', /connection|channel|socket/i],
    ['mock-contract', /not a function|mock/i],
    ['command-not-found', /not recognized|command not found/i],
    ['invalid-executable', /not a valid win32|bad exe|invalid image/i],
    ['syntax', /syntax error|unexpected token|ParserError/i],
    ['sharing-violation', /being used by another process|sharing violation/i],
    ['cim', /CimException|Invoke-CimMethod|Win32_Process\.Create/i]
  ] as const
  return {
    ...structuredCimFailure(output),
    ...(error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'number' &&
    Number.isInteger(error.code)
      ? { nativeExitCode: error.code }
      : {}),
    ...(wmiCreateFailure ? { wmiCreateReturnCode: Number(wmiCreateFailure[1]) } : {}),
    ...(commandFailure
      ? {
          remoteExitCode: Number(commandFailure[2]),
          commandPhase,
          outputCharacters: output.length,
          outputLines: output
            .split(/\r?\n/)
            .slice(0, 12)
            .map((line, index) => ({
              index,
              categories: categories
                .filter(([, pattern]) => pattern.test(line))
                .map(([label]) => label)
            }))
        }
      : {}),
    kind:
      error instanceof Error
        ? error.constructor.name.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 64)
        : typeof error,
    categories: categories.filter(([, pattern]) => pattern.test(output)).map(([label]) => label),
    frames:
      error instanceof Error
        ? [
            ...(error.stack ?? '')
              .split('\n')
              .filter((line) => /^\s+at /u.test(line))
              .slice(0, 8)
              .join('\n')
              .slice(0, 16384)
              .matchAll(/([a-zA-Z0-9_-]+\.(?:ts|js|mjs|cjs)):(\d+):(\d+)/g)
          ]
            .slice(0, 8)
            .map((match) => `${match[1]}:${match[2]}:${match[3]}`)
        : []
  }
}
it('retains numeric remote failure evidence without leaking command or output text', () => {
  const result = classifyFailure(
    new Error(
      'Command "bun.exe --detached secret-token permission-test" failed (exit 5): Access is denied.\nC:\\Users\\secret-user'
    )
  )
  expect(result).toMatchObject({
    remoteExitCode: 5,
    commandPhase: 'detached-launch',
    categories: ['permission'],
    outputLines: [
      { index: 0, categories: ['permission'] },
      { index: 1, categories: [] }
    ]
  })
  expect(JSON.stringify(result)).not.toMatch(/secret|bun.exe|permission-test|Users/)
  const scriptOnly = classifyFailure(
    new Error('Command "bun.exe permission check" failed (exit 2): Nothing classified')
  )
  expect(scriptOnly).toMatchObject({ remoteExitCode: 2, categories: [] })
})
it('preserves the numeric WMI creation verdict', () => {
  expect(
    classifyFailure(
      new Error('Command "bun --detached" failed (exit 1): Win32_Process.Create failed with 2')
    )
  ).toMatchObject({
    remoteExitCode: 1,
    wmiCreateReturnCode: 2,
    commandPhase: 'detached-launch',
    categories: ['cim']
  })
})
it('decodes compressed command phase without classifying its private command text', () => {
  const command = powerShellCommand(
    'bun.exe --detached secret-token permission-test; ' + '# private\n'.repeat(1000)
  )
  const result = classifyFailure(
    new Error(`Command "${command}" failed (exit 1): Nothing classified`)
  )
  expect(result).toMatchObject({ commandPhase: 'detached-launch', categories: [] })
  expect(JSON.stringify(result)).not.toMatch(/secret|private|bun.exe|permission-test/)
})
it('extracts only allowlisted CIM metadata from serialized PowerShell errors', () => {
  const output =
    '#< CLIXML\n<Objs><S S="Error">Invoke-CimMethod : Access is denied._x000D__x000A_' +
    'At line:1 char:2_x000D__x000A_+ bun.exe --detached secret-token_x000D__x000A_' +
    '+ CategoryInfo : PermissionDenied: (Win32_Process:String) [Invoke-CimMethod], CimException_x000D__x000A_' +
    '+ FullyQualifiedErrorId : HRESULT 0x80070005,Microsoft.Management.Infrastructure.CimCmdlets.InvokeCimMethodCommand_x000D__x000A_' +
    'HResult: -2147024891_x000D__x000A_NativeErrorCode: 5_x000D__x000A_' +
    '</S><S S="Verbose">bun.exe private secret-token</S></Objs>'
  const result = classifyFailure(new Error(`Command "private" failed (exit 1): ${output}`))
  expect(result).toMatchObject({
    categories: ['permission', 'cim'],
    cimErrorId: 'HRESULT 0x80070005',
    powerShellCategory: 'PermissionDenied',
    hresult: -2147024891,
    nativeErrorCode: 5
  })
  expect(result).not.toHaveProperty('wmiCreateReturnCode')
  expect(JSON.stringify(result)).not.toMatch(
    /secret|private|bun.exe|Win32_Process|InvokeCimMethodCommand/
  )
})
it('does not retain unknown identifiers, paths, numeric source echoes or incomplete XML', () => {
  const output =
    '+ secret-token HResult: 123\n' +
    'FullyQualifiedErrorId : C:\\Users\\secret-token,Microsoft.Management.Infrastructure.CimCmdlets.InvokeCimMethodCommand\n' +
    'CategoryInfo : secret-token: unknown\nHResult: 0x80041003\nNativeErrorCode: 12345678901234'
  const result = classifyFailure(new Error(output))
  expect(result).toMatchObject({ hresult: 2147749891 })
  expect(result).not.toHaveProperty('cimErrorId')
  expect(result).not.toHaveProperty('powerShellCategory')
  expect(result).not.toHaveProperty('nativeErrorCode')
  const unknownHresult = classifyFailure(
    new Error(
      'FullyQualifiedErrorId : HRESULT 0x80041001,Microsoft.Management.Infrastructure.CimCmdlets.InvokeCimMethodCommand'
    )
  )
  expect(unknownHresult).toMatchObject({ hresult: 2147749889 })
  expect(unknownHresult).not.toHaveProperty('cimErrorId')
  expect(JSON.stringify(result)).not.toMatch(/secret|Users/)
  expect(classifyFailure(new Error('#< CLIXML\n<S S="Error">permission'))).toMatchObject({
    categories: []
  })
  expect(
    classifyFailure(new Error('Command "private" failed (exit 1): ' + 'x'.repeat(262144)))
  ).toMatchObject({ categories: [] })
})
const configPath = process.env.ORCA_SSH_PROBE_CONFIG
it(
  'native ARM OpenSSH candidate provider preserves all settled rows and shell state',
  { timeout: 600_000 },
  async () => {
    if (!configPath || !process.env.ORCA_SSH_PROBE_STATE)
      throw new Error('Explicit private SSH fixture configuration is required')
    expect(process.platform).toBe('win32')
    expect(process.arch).toBe('arm64')
    const config = record(JSON.parse(readFileSync(configPath!, 'utf8')))
    const source = textField(config, 'sourceCommit')
    expect(source).toMatch(/^[a-f0-9]{40}$/)
    // CI wrapper verifies git HEAD before starting this process and writes immutable receipt.
    expect(textField(config, 'observedSourceCommit')).toBe(source)
    const port = config.port
    if (typeof port !== 'number' || !Number.isInteger(port))
      throw new Error('Invalid private SSH port')
    const instance = `arm-native-${randomUUID()}`
    const createConnection = (): SshConnection =>
      new SshConnection(
        {
          id: instance,
          label: instance,
          host: '127.0.0.1',
          port,
          username: textField(config, 'username'),
          identityFile: textField(config, 'identityFile'),
          identitiesOnly: true,
          source: 'manual'
        },
        {
          onStateChange: () => {},
          onCredentialRequest: async () => {
            throw new Error('Interactive auth forbidden')
          }
        }
      )
    let conn = createConnection()
    const hello = { protocolVersion: 1, clientInstanceId: instance, requestedRole: 'session-owner' }
    let mux: SshChannelMultiplexer | undefined
    let grant: Record<string, unknown> | undefined
    const terminals = new Set<string>()
    let daemon: { pid: number; creationTimeMs?: number } | undefined
    const shellIdentities: { pid: number; creationTimeMs: number }[] = []
    let output = ''
    const fixtureDirectories: string[] = []
    let remoteRelayDirectory = ''
    let deployedRuntime = ''
    let candidate: ReturnType<typeof installCandidateOverride> | undefined
    let deploymentStarted = false
    let stage = 'connecting'
    const stages: string[] = []
    const receipts: Record<string, unknown> = { source, instance, cleanupVerified: false, stages }
    const deploy = async (): Promise<void> => {
      deploymentStarted = true
      stage = 'deployment'
      const allowedProgress = [
        'Detecting remote platform...',
        'Checking existing relay...',
        'Uploading relay...',
        'Installing native dependencies...',
        'Starting relay...'
      ]
      const result = await deployAndLaunchRelay(
        conn,
        (status) => {
          if (allowedProgress.includes(status)) {
            stage = status
            if (stages.length < 32) stages.push(status)
          }
        },
        60,
        instance
      )
      stage = 'artifact-and-runtime-identity'
      expect(result.platform).toBe('win32-arm64')
      expect(result.nodePath?.toLowerCase()).toContain('bun')
      if (!result.remoteRelayDir) throw new Error('Missing actual remote relay directory')
      const artifactHashes: Record<string, string> = {}
      for (const filename of [
        'relay.js',
        'parcel-watcher.node',
        'windows-process-tree.node',
        ...RELAY_WINDOWS_CONPTY_FILENAMES
      ]) {
        const expected = createHash('sha256')
          .update(readFileSync(join(process.cwd(), 'out', 'relay', 'win32-arm64', filename)))
          .digest('hex')
        const actual = createHash('sha256')
          .update(readFileSync(join(result.remoteRelayDir, filename)))
          .digest('hex')
        expect(actual).toBe(expected)
        artifactHashes[filename] = actual
      }
      receipts.deployedArtifacts = artifactHashes
      const runtimePath = result.nodePath
      if (!runtimePath) throw new Error('Missing actual runtime executable')
      const runtimeHash = createHash('sha256').update(readFileSync(runtimePath)).digest('hex')
      expect(runtimeHash).toBe(ORCAD_BUN_RELEASE_ASSETS['win32-arm64'].executableSha256)
      remoteRelayDirectory = result.remoteRelayDir
      deployedRuntime = runtimePath
      receipts.runtime = {
        path: runtimePath,
        sha256: runtimeHash,
        expectedSourcePin: false,
        candidateOverride: true
      }
      if (!result.credentialFile) throw new Error('Deployment omitted private credential identity')
      const nextMux = new SshChannelMultiplexer(result.transport)
      mux = nextMux
      nextMux.onDispose(() => {
        if (mux === nextMux) mux = undefined
      })
      mux.onNotificationByMethod('pty.data', (message) => {
        if (typeof message.data === 'string') output = (output + message.data).slice(-65536)
      })
      const rows = await readWindowsProcessTableFresh()
      const normalizeCommand = (value: string): string => value.replaceAll('\\', '/').toLowerCase()
      const owners = rows.filter(
        (row) =>
          normalizeCommand(row.command).includes(normalizeCommand(result.credentialFile!)) &&
          row.command.includes('--detached')
      )
      expect(owners).toHaveLength(1)
      expect(owners[0].name.toLowerCase()).toBe('bun.exe')
      const command = normalizeCommand(owners[0].command)
      const executable = normalizeCommand(runtimePath)
      expect(
        command.startsWith('\"' + executable + '\" ') || command.startsWith(executable + ' ')
      ).toBe(true)
      const descendants = new Set([owners[0].pid])
      for (let changed = true; changed;) {
        changed = false
        for (const row of rows)
          if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
            descendants.add(row.pid)
            changed = true
          }
      }
      expect(
        rows.filter((row) => descendants.has(row.pid) && row.name.toLowerCase() === 'node.exe')
      ).toEqual([])
      receipts.hostNodeExclusion = {
        relayImage: 'bun.exe',
        descendantSnapshotHasNode: false,
        scope: 'daemon and live descendants at deployment/reconnect snapshots'
      }
      if (!owners[0].creationTimeMs) throw new Error('Daemon process identity unverifiable')
      if (daemon) expect(owners[0]).toMatchObject(daemon)
      daemon = { pid: owners[0].pid, creationTimeMs: owners[0].creationTimeMs }
      receipts.daemon = daemon
      const admitted = record(
        await mux.request('pty.openClient', {
          ...hello,
          ...(grant
            ? { resume: { ownerGeneration: grant.ownerGeneration, ownerLease: grant.ownerLease } }
            : {})
        })
      )
      if (grant) expect(admitted.resumed).toBe(true)
      if (!('ownerGeneration' in admitted) || typeof admitted.ownerLease !== 'string')
        throw new Error('Missing lease')
      grant = admitted
    }
    const spawn = async (): Promise<string> => {
      const result = record(
        await mux!.request('pty.spawn', { cols: 80, rows: 24, shellOverride: 'powershell.exe' })
      )
      const id = textField(result, 'id')
      terminals.add(id)
      return id
    }
    try {
      const stateRoot = process.env.ORCA_SSH_PROBE_STATE
      if (!stateRoot) throw new Error('Missing isolated SSH probe state root')
      setAppEnvironment({
        getPath: (name) => (name === 'userData' ? stateRoot : stateRoot),
        getAppPath: () => process.cwd(),
        getVersion: () => 'diagnostic',
        isPackaged: () => false,
        onWillQuit: () => {},
        exit: (code) => { throw new Error(`unexpected app exit: ${code ?? 0}`) },
        getAppMetrics: () => []
      })
      candidate = installCandidateOverride(config, stateRoot)
      receipts.candidateAdmission = candidate.receipt
      await conn.connect()
      await deploy()
      const id = await spawn()
      const nonce = randomUUID().replaceAll('-', '')
      output = ''
      mux!.notify('pty.data', {
        id,
        data: `$orcaProbe='${nonce}'; Write-Output ('READY_' + $orcaProbe + '_' + $PID)\r`
      })
      await expect.poll(() => output, { timeout: 30000 }).toContain(`READY_${nonce}_`)
      const before = output.match(new RegExp(`READY_${nonce}_(\\d+)`))?.[1]
      expect(before).toBeTruthy()
      const shell = (await readWindowsProcessTableFresh()).find((row) => row.pid === Number(before))
      if (!shell?.creationTimeMs) throw new Error('Shell identity unverifiable')
      shellIdentities.push({ pid: shell.pid, creationTimeMs: shell.creationTimeMs })
      mux!.dispose('connection_lost')
      mux = undefined
      await conn.disconnect()
      conn = createConnection()
      await conn.connect()
      await deploy()
      await mux!.request('pty.attach', { id })
      output = ''
      mux!.notify('pty.data', { id, data: "Write-Output ('AFTER_' + $orcaProbe + '_' + $PID)\r" })
      await expect.poll(() => output, { timeout: 30000 }).toContain(`AFTER_${nonce}_${before}`)
      receipts.sameShellState = true
      stage = 'provider-resize-and-loaded-images'
      receipts.repaint = await proveRepaint({
        mux: mux!,
        runtime: deployedRuntime,
        fixtureParent: dirname(remoteRelayDirectory),
        receiptPath: join(dirname(textField(config, 'receiptPath')), 'repaint-events.json'),
        ownTerminal: (terminalId) => {
          terminals.add(terminalId)
        },
        ownDirectory: (directory) => {
          fixtureDirectories.push(directory)
        },
        observeProvider: async () => {
          if (!daemon) throw new Error('Missing owned daemon identity')
          const evidence = await inspectProviderImages(daemon, remoteRelayDirectory)
          shellIdentities.push(...evidence.descendantIdentities)
          return evidence
        }
      })
      const fresh = await spawn()
      output = ''
      mux!.notify('pty.data', { id: fresh, data: "Write-Output ('FRESH_' + $PID)\r" })
      await expect.poll(() => output, { timeout: 30000 }).toMatch(/FRESH_\d+/)
      const freshPid = Number(output.match(/FRESH_(\d+)/)?.[1])
      const freshShell = (await readWindowsProcessTableFresh()).find((row) => row.pid === freshPid)
      if (!freshShell?.creationTimeMs) throw new Error('Fresh shell identity unverifiable')
      shellIdentities.push({ pid: freshShell.pid, creationTimeMs: freshShell.creationTimeMs })
      await mux!.request('pty.shutdown', { id: fresh, immediate: true })
      terminals.delete(fresh)
    } catch (error) {
      receipts.primaryFailure = { stage, ...classifyFailure(error) }
      throw new Error('Production SSH route failed; inspect sanitized primaryFailure receipt')
    } finally {
      try {
        if (!mux && daemon) {
          await conn.disconnect()
          conn = createConnection()
          await conn.connect()
          await deploy()
        }
        if (mux) {
          for (const id of terminals) await mux.request('pty.shutdown', { id, immediate: true })
          expect(await mux.request('pty.listProcesses', {})).toEqual([])
          mux.dispose()
          mux = undefined
        }
        await conn.disconnect()
        if (daemon)
          await expect
            .poll(
              async () => {
                const rows = await readWindowsProcessTableFresh()
                return rows.some(
                  (row) => row.pid === daemon!.pid && row.creationTimeMs === daemon!.creationTimeMs
                )
              },
              { timeout: 90000, interval: 1000 }
            )
            .toBe(false)
        for (const shell of shellIdentities) {
          const rows = await readWindowsProcessTableFresh()
          expect(
            rows.some((row) => row.pid === shell.pid && row.creationTimeMs === shell.creationTimeMs)
          ).toBe(false)
        }
        receipts.cleanupVerified = Boolean(daemon) || !deploymentStarted
        if (!receipts.cleanupVerified)
          throw new Error('Deployment may have launched an unobserved relay; cleanup unverifiable')
        for (const directory of fixtureDirectories)
          rmSync(directory, { recursive: true, force: true })
      } catch (error) {
        receipts.cleanupFailure = classifyFailure(error)
        throw error
      } finally {
        candidate?.restore()
        receipts.sourcePinRestored = true
        mux?.dispose()
        try {
          await conn.disconnect()
        } finally {
          writeFileSync(textField(config, 'receiptPath'), JSON.stringify(receipts, null, 2))
        }
      }
    }
  }
)
