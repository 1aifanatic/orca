// Exercises the driver's actual transition oracle using private files and simulated installer events.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, renameSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const code = readFileSync(join(import.meta.dirname, 'run-installed.mjs'), 'utf8')
const transition = code.slice(code.indexOf('async function transition('), code.indexOf('async function stop('))
const root = mkdtempSync(join(tmpdir(), 'oui-test-'))
const create = new Function('context', `
  const {root,randomBytes,join,writeFileSync,renameSync,readFileSync,existsSync,scenario}=context;
  let currentVersion='1.0.0',servingPid=11,installInFlight=false;
  const selectionSecret='private-test-secret',profile='/private/test-profile';
  const child={pid:10,exitCode:null,signalCode:null};
  const receipt={B:{version:'2.0.0',appAsarSha256:'asar',cliEntrySha256:'cli',executableSha256:'exe',bunSha256:'bun',daemonEntrySha256:'daemon'}};
  const operations=[];
  const check=()=>{};
  const waitStatus=async(state,version)=>{
    operations.push(state);
    if(state==='available'){
      const request=JSON.parse(readFileSync(join(root,'update-request.json'),'utf8'));
      writeFileSync(join(root,'update-response.json'),JSON.stringify({id:request.id,phase:'selected',targetVersion:version}));
    }
  };
  const updater=async action=>{
    operations.push(action);
    if(action==='install'){
      if(scenario==='install-interrupted')throw Error('transport lost after acceptance unknown');
      return {accepted:true,fromVersion:'1.0.0',targetVersion:'2.0.0'};
    }
  };
  const readiness={next:async()=>{operations.push('replacement-ready');return {}}};
  const acceptReady=async()=>{servingPid=scenario==='same-process'?11:12};
  const runtimeServeSmokeProcessState=()=>scenario==='old-live'?'live':'exited';
  const run=async program=>program.includes('PlistBuddy')?(scenario==='wrong-version'?'1.0.0':'2.0.0'):'';
  const hash=async path=>scenario==='wrong-hash'?'bad':path.endsWith('app.asar')?'asar':path.endsWith('index.js')?'cli':path.endsWith('/Orca')?'exe':path.endsWith('bun-runtime')?'bun':'daemon';
  const waitUpdaterReady=async()=>({appVersion:'2.0.0'});
  ${transition}
  return {transition,receipt,operations,pending:()=>installInFlight};
`)
try {
  for (const scenario of ['success','same-process','old-live','wrong-version','wrong-hash','install-interrupted']) {
    const fixture=create({root,randomBytes,join,writeFileSync,renameSync,readFileSync,existsSync,scenario})
    if(scenario==='success'){
      await fixture.transition('B','/isolated/Orca.app')
      assert.equal(fixture.receipt.installs.length,1)
      assert.equal(fixture.pending(),false)
      assert.deepEqual(fixture.operations,['available','download','downloaded','install','replacement-ready'])
    } else {
      await assert.rejects(fixture.transition('B','/isolated/Orca.app'))
      assert.equal(fixture.pending(),true,'uncertain native install must retain keychain/profile')
      assert.equal(fixture.receipt.installs,undefined,'bad evidence must never publish a passed install')
    }
  }
  console.log('Installed transition oracle rejects reused/live old process, wrong version/hash and unknown install; keeps cleanup guard')
} finally {rmSync(root,{recursive:true,force:true})}
