import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

// Only Electron artifact discovery is substituted; SSH/deployment/leases stay real.
vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd(), getPath: () => process.env.ORCA_SSH_PROBE_STATE } }))
import { ORCAD_BUN_RELEASE_ASSETS } from '../../shared/orcad-bun-runtime'
import { SshConnection } from './ssh-connection'
import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { readWindowsProcessTableFresh } from '../windows/windows-process-table'

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid RPC object')
  return Object.fromEntries(Object.entries(value))
}
function textField(value: Record<string, unknown>, key: string): string {
  const text = value[key]
  if (typeof text !== 'string' || !text) throw new Error(`Missing ${key}`)
  return text
}
function classifyFailure(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : ''
  const categories = [
    ['sftp', /sftp|subsystem/i], ['permission', /permission|access.denied/i],
    ['missing-file', /not.found|ENOENT|missing/i], ['timeout', /timed?.?out|timeout/i],
    ['runtime', /bun|runtime/i], ['integrity', /hash|sha256|integrity/i],
    ['connection', /connection|channel|socket/i], ['mock-contract', /not a function|mock/i]
  ] as const
  return {
    kind: error instanceof Error ? error.constructor.name.replace(/[^a-zA-Z0-9_]/g, '').slice(0,64) : typeof error,
    categories: categories.filter(([,pattern]) => pattern.test(message)).map(([label]) => label),
    frames: error instanceof Error ? [...(error.stack ?? '').matchAll(/([a-zA-Z0-9_-]+\.(?:ts|js|mjs|cjs)):(\d+):(\d+)/g)].slice(0,8).map(match => `${match[1]}:${match[2]}:${match[3]}`) : []
  }
}
const configPath = process.env.ORCA_SSH_PROBE_CONFIG
it.skipIf(!configPath)('native ARM OpenSSH deploy preserves the owned shell across transport loss', { timeout: 600_000 }, async () => {
  expect(process.platform).toBe('win32')
  expect(process.arch).toBe('arm64')
  const config = record(JSON.parse(readFileSync(configPath!, 'utf8')))
  const source = textField(config, 'sourceCommit')
  expect(source).toMatch(/^[a-f0-9]{40}$/)
  // CI wrapper verifies git HEAD before starting this process and writes immutable receipt.
  expect(textField(config, 'observedSourceCommit')).toBe(source)
  const port = config.port
  if (typeof port !== 'number' || !Number.isInteger(port)) throw new Error('Invalid private SSH port')
  const instance = `arm-native-${randomUUID()}`
  const createConnection = (): SshConnection => new SshConnection({ id: instance, label: instance, host: '127.0.0.1', port,
    username: textField(config, 'username'), identityFile: textField(config, 'identityFile'), identitiesOnly: true, source: 'manual' },
    { onStateChange: () => {}, onCredentialRequest: async () => { throw new Error('Interactive auth forbidden') } })
  let conn = createConnection()
  const hello = { protocolVersion: 1, clientInstanceId: instance, requestedRole: 'session-owner' }
  let mux: SshChannelMultiplexer | undefined
  let grant: Record<string, unknown> | undefined
  const terminals = new Set<string>()
  let daemon: {pid: number; creationTimeMs?: number} | undefined
  const shellIdentities: {pid:number;creationTimeMs:number}[]=[]
  let output = ''
  let deploymentStarted=false
  let stage='connecting'
  const stages: string[]=[]
  const receipts: Record<string, unknown> = { source, instance, cleanupVerified: false, stages }
  const deploy = async (): Promise<void> => {
    deploymentStarted=true
    stage='deployment'
    const allowedProgress=['Detecting remote platform...', 'Checking existing relay...', 'Uploading relay...', 'Installing native dependencies...', 'Starting relay...']
    const result = await deployAndLaunchRelay(conn, status => {
      if (allowedProgress.includes(status)) { stage=status; if(stages.length < 32) stages.push(status) }
    }, 60, instance)
    stage='artifact-and-runtime-identity'
    expect(result.platform).toBe('win32-arm64')
    expect(result.nodePath?.toLowerCase()).toContain('bun')
    if (!result.remoteRelayDir) throw new Error('Missing actual remote relay directory')
    const artifactHashes: Record<string, string> = {}
    for (const filename of ['relay.js', 'parcel-watcher.node', 'windows-process-tree.node']) {
      const expected = createHash('sha256').update(readFileSync(join(process.cwd(), 'out', 'relay', 'win32-arm64', filename))).digest('hex')
      const actual = createHash('sha256').update(readFileSync(join(result.remoteRelayDir, filename))).digest('hex')
      expect(actual).toBe(expected)
      artifactHashes[filename] = actual
    }
    receipts.deployedArtifacts = artifactHashes
    const runtimePath=result.nodePath
    if (!runtimePath) throw new Error('Missing actual runtime executable')
    const runtimeHash=createHash('sha256').update(readFileSync(runtimePath)).digest('hex')
    expect(runtimeHash).toBe(ORCAD_BUN_RELEASE_ASSETS['win32-arm64'].executableSha256)
    receipts.runtime={path:runtimePath,sha256:runtimeHash,expectedSourcePin:true}
    if (!result.credentialFile) throw new Error('Deployment omitted private credential identity')
    const nextMux = new SshChannelMultiplexer(result.transport)
    mux = nextMux
    nextMux.onDispose(() => { if (mux === nextMux) mux = undefined })
    mux.onNotificationByMethod('pty.data', (message) => { if (typeof message.data === 'string') output=(output+message.data).slice(-65536) })
    const rows = await readWindowsProcessTableFresh()
    const normalizeCommand = (value: string): string => value.replaceAll('\\', '/').toLowerCase()
    const owners = rows.filter(row => normalizeCommand(row.command).includes(normalizeCommand(result.credentialFile!)) && row.command.includes('--detached'))
    expect(owners).toHaveLength(1)
    expect(owners[0].name.toLowerCase()).toBe('bun.exe')
    const command=normalizeCommand(owners[0].command)
    const executable=normalizeCommand(runtimePath)
    expect(command.startsWith('\"'+executable+'\" ') || command.startsWith(executable+' ')).toBe(true)
    const descendants=new Set([owners[0].pid])
    for(let changed=true;changed;) {
      changed=false
      for(const row of rows) if(descendants.has(row.ppid) && !descendants.has(row.pid)) {descendants.add(row.pid);changed=true}
    }
    expect(rows.filter(row=>descendants.has(row.pid) && row.name.toLowerCase()==='node.exe')).toEqual([])
    receipts.hostNodeExclusion={relayImage:'bun.exe',descendantSnapshotHasNode:false,scope:'daemon and live descendants at deployment/reconnect snapshots'}
    if (!owners[0].creationTimeMs) throw new Error('Daemon process identity unverifiable')
    if (daemon) expect(owners[0]).toMatchObject(daemon)
    daemon = {pid: owners[0].pid, creationTimeMs: owners[0].creationTimeMs}
    receipts.daemon=daemon
    const admitted = record(await mux.request('pty.openClient', {...hello, ...(grant ? {resume: {ownerGeneration:grant.ownerGeneration,ownerLease:grant.ownerLease}} : {})}))
    if (grant) expect(admitted.resumed).toBe(true)
    if (!('ownerGeneration' in admitted) || typeof admitted.ownerLease !== 'string') throw new Error('Missing lease')
    grant=admitted
  }
  const spawn = async (): Promise<string> => {
    const result=record(await mux!.request('pty.spawn',{cols:80,rows:24,shellOverride:'powershell.exe'}))
    const id=textField(result,'id');terminals.add(id);return id
  }
  try {
    await conn.connect()
    await deploy()
    const id=await spawn()
    const nonce=randomUUID().replaceAll('-','')
    output=''
    mux!.notify('pty.data',{id,data:`$orcaProbe='${nonce}'; Write-Output ('READY_' + $orcaProbe + '_' + $PID)\r`})
    await expect.poll(()=>output,{timeout:30000}).toContain(`READY_${nonce}_`)
    const before=output.match(new RegExp(`READY_${nonce}_(\\d+)`))?.[1]
    expect(before).toBeTruthy()
    const shell=(await readWindowsProcessTableFresh()).find(row=>row.pid===Number(before))
    if (!shell?.creationTimeMs) throw new Error('Shell identity unverifiable')
    shellIdentities.push({pid:shell.pid,creationTimeMs:shell.creationTimeMs})
    mux!.dispose('connection_lost');mux=undefined
    await conn.disconnect()
    conn = createConnection()
    await conn.connect()
    await deploy()
    await mux!.request('pty.attach',{id})
    output=''
    mux!.notify('pty.data',{id,data:"Write-Output ('AFTER_' + $orcaProbe + '_' + $PID)\r"})
    await expect.poll(()=>output,{timeout:30000}).toContain(`AFTER_${nonce}_${before}`)
    receipts.sameShellState=true
    const fresh=await spawn()
    output=''
    mux!.notify('pty.data',{id:fresh,data:"Write-Output ('FRESH_' + $PID)\r"})
    await expect.poll(()=>output,{timeout:30000}).toMatch(/FRESH_\d+/)
    const freshPid=Number(output.match(/FRESH_(\d+)/)?.[1])
    const freshShell=(await readWindowsProcessTableFresh()).find(row=>row.pid===freshPid)
    if (!freshShell?.creationTimeMs) throw new Error('Fresh shell identity unverifiable')
    shellIdentities.push({pid:freshShell.pid,creationTimeMs:freshShell.creationTimeMs})
    await mux!.request('pty.shutdown',{id:fresh,immediate:true});terminals.delete(fresh)
  } catch (error) {
    receipts.primaryFailure={stage,...classifyFailure(error)}
    throw new Error('Production SSH route failed; inspect sanitized primaryFailure receipt')
  } finally {
    try {
      if (!mux && daemon) { await conn.disconnect(); conn = createConnection(); await conn.connect(); await deploy() }
      if (mux) {
        for (const id of terminals) await mux.request('pty.shutdown',{id,immediate:true})
        expect(await mux.request('pty.listProcesses',{})).toEqual([])
        mux.dispose();mux=undefined
      }
      await conn.disconnect()
      if (daemon) await expect.poll(async()=> {
        const rows=await readWindowsProcessTableFresh()
        return rows.some(row=>row.pid===daemon!.pid && row.creationTimeMs===daemon!.creationTimeMs)
      },{timeout:90000,interval:1000}).toBe(false)
      for (const shell of shellIdentities) {
        const rows=await readWindowsProcessTableFresh()
        expect(rows.some(row=>row.pid===shell.pid && row.creationTimeMs===shell.creationTimeMs)).toBe(false)
      }
      receipts.cleanupVerified=Boolean(daemon) || !deploymentStarted
      if (!receipts.cleanupVerified) throw new Error('Deployment may have launched an unobserved relay; cleanup unverifiable')
    } catch (error) {
      receipts.cleanupFailure=classifyFailure(error)
      throw error
    } finally {
      mux?.dispose()
      await conn.disconnect()
      writeFileSync(textField(config,'receiptPath'),JSON.stringify(receipts,null,2))
    }
  }
})
