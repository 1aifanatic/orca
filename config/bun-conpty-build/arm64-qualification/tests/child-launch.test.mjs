import { describe, it, expect } from 'bun:test'
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
const fixture=dirname(fileURLToPath(import.meta.url))
describe.skipIf(process.platform!=='win32')('production Windows preflight child launch',()=>{
 it.each(['unset','invalid','valid'])('launches selected provider in a real child with %s inherited selector',async(mode)=>{
  const root=mkdtempSync(join(tmpdir(),'orca-child-launch-'))
  let child
  let timer
  try{
   copyFileSync(process.execPath,join(root,'bun-runtime.exe'))
   copyFileSync(join(fixture,'orcad.js'),join(root,'orcad.js'))
   mkdirSync(join(root,'conpty'))
   for(const name of ['conpty.dll','OpenConsole.exe'])copyFileSync(join(dirname(process.env.BUN_CONPTY_LIBRARY),name),join(root,'conpty',name))
   writeFileSync(join(root,'.version'),'0.1.0+123456789abc\n')
   writeFileSync(join(root,'.build-target'),JSON.stringify({platform:'win32',arch:process.arch}))
   const env={...process.env,ORCA_BACKGROUND_LAUNCH:'1'}
   if(mode==='unset')delete env.BUN_CONPTY_LIBRARY
   else env.BUN_CONPTY_LIBRARY=mode==='invalid'?'not-an-absolute-provider.dll':join(root,'conpty','conpty.dll')
   const nonce=randomUUID()
   child=Bun.spawn([join(root,'bun-runtime.exe'),'--no-env-file',join(root,'orcad.js'),'--orcad-profile-state-preflight',nonce],{env,stdin:'ignore',stdout:'pipe',stderr:'pipe'})
   let timedOut=false;timer=setTimeout(()=>{timedOut=true;child.kill()},20000)
   const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()])
   expect(timedOut,stderr).toBe(false);expect(exit,stderr).toBe(0)
   const response=JSON.parse(stdout);expect(response.nonce).toBe(nonce);expect(response.runtime).toBe('bun')
   const parent=JSON.parse(readFileSync(join(root,'parent-proof.json'),'utf8'));const native=JSON.parse(readFileSync(join(root,'child-proof.json'),'utf8'))
   expect(parent.pid).not.toBe(native.pid);expect(native.ppid).toBe(parent.pid)
   expect(native.inherited).toBe(join(root,'conpty','conpty.dll'));expect(native.selected).toBe(native.inherited)
   expect(native.answered).toBe(true);expect(native.exit).toBe(0);expect(native.arch).toBe(process.arch)
   if(mode==='unset')expect(parent.inherited).toBeNull()
   else if(mode==='invalid')expect(parent.inherited).toBe('not-an-absolute-provider.dll')
   console.log('CHILD_LAUNCH_PROOF',JSON.stringify({mode,parent,native}))
  }finally{clearTimeout(timer);child?.kill();if(child)await child.exited;rmSync(root,{recursive:true,force:true})}
 },30000)
})
