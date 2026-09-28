import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { computeOrcadFullVersion } from './project/config/scripts/orcad-artifact-version.mjs'
import { orcadArtifactFilenames } from './project/src/shared/orcad-artifacts.ts'
const arch=process.argv[2]
assert.ok(['x64','arm64'].includes(arch))
const root=import.meta.dirname
const output=join(root,`installed-${arch}`)
mkdirSync(output,{recursive:true})
cpSync(join(root,'payload/common'),output,{recursive:true})
cpSync(join(root,'payload',arch,'conpty'),join(output,'conpty'),{recursive:true})
copyFileSync(join(root,'payload',arch,'watcher.node'),join(output,'node_modules/@parcel/watcher/watcher.node'))
copyFileSync(join(root,'project/.build/windows-process-tree',arch,'windows-process-tree.node'),join(output,'windows-process-tree.node'))
copyFileSync(process.env.BUN_EXECUTABLE,join(output,'bun-runtime.exe'))
writeFileSync(join(output,'.build-target'),`win32-${arch}\n`)
const artifactVersion=computeOrcadFullVersion(output,{target:`win32-${arch}`})
writeFileSync(join(output,'.version'),artifactVersion)
const receipts=resolve(process.env.ORCA_FULL_RECEIPTS)
mkdirSync(receipts,{recursive:true})
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex')
const manifest=Object.fromEntries(orcadArtifactFilenames(`win32-${arch}`).map(file=>[file,hash(join(output,file))]))
writeFileSync(join(receipts,'full-artifact-manifest.json'),JSON.stringify({arch,artifactVersion,manifest},null,2))
const before=new Set(readdirSync(tmpdir()).filter(name=>name.startsWith('orca-profile-preflight-')||name.startsWith('orca-native-ready-')))
const results=[]
for(const selector of ['unset','invalid','valid']) {
 const env={...process.env,ORCA_BACKGROUND_LAUNCH:'1'}
 delete env.BUN_CONPTY_LIBRARY
 if(selector==='invalid') env.BUN_CONPTY_LIBRARY=join(output,'missing-provider.dll')
 if(selector==='valid') env.BUN_CONPTY_LIBRARY=join(output,'conpty/conpty.dll')
 const nonce=randomUUID()
 const start=performance.now()
 const child=spawnSync(join(output,'bun-runtime.exe'),[join(output,'orcad.js'),'--orcad-profile-state-preflight',nonce],{env,encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:1024*1024})
 const result={selector,nonce,elapsedMs:performance.now()-start,pid:child.pid,status:child.status,signal:child.signal,error:child.error?.message,stdout:child.stdout,stderr:child.stderr}
 results.push(result)
 writeFileSync(join(receipts,'full-preflight-results.json'),JSON.stringify(results,null,2))
 console.log(JSON.stringify(result))
 assert.equal(child.status,0,`${selector}: full preflight failed`)
 const response=JSON.parse(child.stdout.trim())
 assert.equal(response.type,'orca_profile_state_ready')
 assert.equal(response.nonce,nonce)
 assert.equal(response.runtime,'bun')
 assert.equal(response.runtimeVersion,'1.4.2')
 assert.equal(response.artifactVersion,artifactVersion)
 assert.ok(typeof response.sqliteVersion==='string'&&response.sqliteVersion.length>0)
 assert.ok(response.revision>0)
}
const leaked=readdirSync(tmpdir()).filter(name=>(name.startsWith('orca-profile-preflight-')||name.startsWith('orca-native-ready-'))&&!before.has(name))
assert.deepEqual(leaked,[])
console.log(JSON.stringify({fullPreflight:'passed',arch,cases:results.length,leaked}))
