// Executes only tiny owned Node children; no app, keychain or daemon access.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { summarizeCommandFailure } from '../mac-app-transition-qualification/command-failure.mjs'
import { join } from 'node:path'
const text = readFileSync(join(import.meta.dirname, 'run-installed.mjs'), 'utf8')
const run = text.slice(text.indexOf('function run('), text.indexOf('async function cli('))
const check = text.match(/function check\(\) \{[^\n]+\}/)?.[0]
const cancel = text.match(/const cancel = \(\) => \{[^\n]+\}/)?.[0]
assert.ok(run && check && cancel)
const fixture = new Function('spawn', 'process', 'source', 'summarizeCommandFailure', `
  let cancelled=false, cleaning=false, launch;
  const auxiliaries=new Set();
  const receipt={commandFailures:[]};
  ${check}
  ${cancel}
  ${run}
  return {run,cancel,cleanup(){cleaning=true},count(){return auxiliaries.size}};
`)(spawn, process, import.meta.dirname, summarizeCommandFailure)
const pending = fixture.run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 2000 })
setTimeout(fixture.cancel, 50)
await assert.rejects(pending, /exit/)
assert.equal(fixture.count(), 0, 'cancelled command reaped')
fixture.cleanup()
const retiring = fixture.run(process.execPath, ['-e', 'setTimeout(()=>console.log("retired"),80)'], { cleanup: true, timeout: 2000 })
setTimeout(fixture.cancel, 30)
assert.equal(await retiring, 'retired', 'repeat cancellation must not interrupt authenticated cleanup')
assert.equal(fixture.count(), 0, 'cleanup child reaped')
writeFileSync(join(import.meta.dirname, 'cancellation-test.json'), JSON.stringify({ status: 'passed', checks: ['cancelled auxiliary reaped', 'repeat cancellation preserves cleanup auxiliary', 'cleanup auxiliary reaped'], appLaunches: 0, keychainOperations: 0 }, null, 2) + '\n')
console.log('Synthetic owned-child cancellation checks passed')
