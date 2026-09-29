import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess } from '../../../shared/child-process/run-process'
import { orcadBunRuntimeFilename } from '../../../shared/orcad-artifacts'
import { removeTreeSync } from '../../../shared/windows-transient-lock-removal'

const runtimePath =
  process.env.BUN_EXECUTABLE ??
  resolve(__dirname, '../../../../out/orcad', orcadBunRuntimeFilename(process.platform))

async function runDirect(script: string): Promise<unknown> {
  const directory = mkdtempSync(join(tmpdir(), 'orca-bun-direct-'))
  try {
    const entry = join(directory, 'terminal.cjs')
    writeFileSync(
      entry,
      [
        `const {spawnBunPty} = require(${JSON.stringify(join(__dirname, 'bun-pty-process.ts'))})`,
        `const {supportsWindowsDirectJobSpawn} = require(${JSON.stringify(join(__dirname, 'windows-bun-direct-job-spawn.ts'))})`,
        `if (!supportsWindowsDirectJobSpawn(Bun)) { console.log(JSON.stringify({unsupported:true})); process.exit(0) }`,
        `const args = {file: process.execPath, cwd: ${JSON.stringify(directory)}, env: process.env, cols: 80, rows: 24}`,
        script
      ].join('\n')
    )
    const result = await runProcess({ program: runtimePath, args: [entry], timeoutMs: 30_000 })
    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr).toBe(0)
    return JSON.parse(result.stdout)
  } finally {
    removeTreeSync(directory)
  }
}

// Requires Orca's patched Bun (windowsJob); a stock runtime reports unsupported and the gate tests cover it.
describe.skipIf(!existsSync(runtimePath) || process.platform !== 'win32')(
  'native Windows Bun terminal without a resident gate',
  () => {
    it('creates the shell as the job root and owns its whole tree', async () => {
      const result = await runDirect(`
      const script = 'for(let i=0;i<65;i++)Bun.spawn([process.execPath,"-e","setInterval(()=>{},1000)"],{stdin:"ignore",stdout:"ignore",stderr:"ignore"});setInterval(()=>console.log("tick"),10)'
      const proc = spawnBunPty({...args,args:['-e',script]})
      let bytes=0,started=false,evidence
      proc.onData(data=>{
        bytes+=data.length
        if(started || !data.includes('tick'))return
        const members=proc.listOwnedProcessIds()
        if(!members || members.length<66)return
        started=true
        const identity={shellIsRoot:proc.shellProcessId===proc.pid, rootOwned:members.includes(proc.pid), wrapper:proc.jobRootProcessIsWrapper===true, members:members.length}
        proc.pause()
        setTimeout(()=>{
          const pausedBytes=bytes
          setTimeout(()=>{
            const stopped=bytes===pausedBytes
            proc.resume()
            setTimeout(()=>{
              evidence={...identity,stopped,resumed:bytes>pausedBytes}
              proc.kill()
            },150)
          },150)
        },150)
      })
      proc.onExit(()=>{
        console.log(JSON.stringify(evidence))
        proc.destroy()
      })
    `)
      if (result && typeof result === 'object' && 'unsupported' in result) {
        return
      }
      expect(result).toEqual({
        shellIsRoot: true,
        rootOwned: true,
        wrapper: false,
        members: 66,
        stopped: true,
        resumed: true
      })
    }, 35_000)

    it('falls back after an actual shell spawn rejection', async () => {
      const result = await runDirect(`
      const {spawnNativeDaemonPty} = require(${JSON.stringify(join(__dirname, 'native-pty-spawn.ts'))})
      const {join} = require('node:path')
      const attempts = [join(args.cwd,'missing-pwsh.exe'),process.execPath].map(shellPath=>({
        shellPath,shellArgs:['-e','process.exitCode=17'],effectiveCwd:args.cwd,validationCwd:args.cwd,startupCommandDeliveredInShellArgs:true
      }))
      spawnNativeDaemonPty({
        shellPath:attempts[0].shellPath,shellArgs:attempts[0].shellArgs,spawnCwd:args.cwd,
        env:args.env,cols:80,rows:24,windowsFallbackAttempts:attempts
      }, {canUseBunPty:()=>true, spawnBunPty}).then(({process:proc,shellPath})=>{
        proc.onExit(event=>{
          console.log(JSON.stringify({event,fallback:shellPath===process.execPath}))
          proc.destroy()
        })
      }).catch(error=>{console.error(error);process.exitCode=1})
    `)
      if (result && typeof result === 'object' && 'unsupported' in result) {
        return
      }
      expect(result).toEqual({ event: { exitCode: 17 }, fallback: true })
    }, 35_000)
  }
)
