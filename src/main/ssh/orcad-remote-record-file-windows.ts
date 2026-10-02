/**
 * The Windows half of `orcad-remote-record-file.ts`: same markers, same "unreadable is not
 * absent" rule, run by the pinned node.exe rather than `sh`.
 *
 * The contents are never on a command line. They are staged through the connection's file write
 * (sftp first; see `system-ssh-windows-write-strategy.ts`), then one node.exe fsyncs the stage
 * and renames it over the record, retrying the EPERM/EACCES/EBUSY an antivirus scan causes.
 */
import { orcadWindowsEncodedAnswerJs, orcadWindowsNodeCommand } from './orcad-remote-windows-node'

/** Exit code for "the record exists but cannot be read within its bound". */
const UNREADABLE_EXIT = 65

/** Args: path, max bytes. Prints `absent`, or `present base64`; exits 65 when unreadable. */
export function windowsOrcadRecordReadScript(markers: { absent: string; present: string }): string {
  const script = [
    'const fs=require("fs");',
    'const [file,maxArg]=process.argv.slice(1);const max=Number(maxArg);',
    'let s;try{s=fs.lstatSync(file)}catch(e){',
    `if(e.code==="ENOENT"){process.stdout.write(${JSON.stringify(`${markers.absent}\n`)},()=>process.exit(0));return}`,
    `process.exit(${UNREADABLE_EXIT})}`,
    `if(!s.isFile()||s.size>max)process.exit(${UNREADABLE_EXIT});`,
    'const fd=fs.openSync(file,"r");let b=Buffer.alloc(max+1);',
    'try{b=b.subarray(0,fs.readSync(fd,b,0,max+1,0))}finally{fs.closeSync(fd)}',
    `if(b.length>max)process.exit(${UNREADABLE_EXIT});`,
    orcadWindowsEncodedAnswerJs(markers.present, 'b')
  ].join('')
  // Why wrapped: a top-level `return` is only legal inside a function body.
  return `(()=>{${script}})()`
}

export function windowsOrcadRecordReadCommand(
  nodePath: string,
  path: string,
  maxBytes: number,
  markers: { absent: string; present: string }
): string {
  return orcadWindowsNodeCommand(nodePath, [
    '-e',
    windowsOrcadRecordReadScript(markers),
    path,
    String(maxBytes)
  ])
}

const RENAME_RETRY_DELAYS_MS = [50, 100, 150, 200, 250]

/** Args: staged path, record path. */
export const ORCAD_WINDOWS_RECORD_PUBLISH_JS = [
  'const fs=require("fs");',
  'const [staged,file]=process.argv.slice(1);',
  'const fd=fs.openSync(staged,"r+");try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}',
  `const delays=${JSON.stringify(RENAME_RETRY_DELAYS_MS)};let attempt=0;`,
  'const publish=()=>{try{fs.renameSync(staged,file)}catch(e){',
  'if(["EPERM","EACCES","EBUSY"].includes(e.code)&&attempt<delays.length){setTimeout(publish,delays[attempt++]);return}',
  'throw e}};',
  'publish();'
].join('')

export function windowsOrcadRecordPublishCommand(
  nodePath: string,
  stagedPath: string,
  path: string
): string {
  return orcadWindowsNodeCommand(nodePath, [
    '-e',
    ORCAD_WINDOWS_RECORD_PUBLISH_JS,
    stagedPath,
    path
  ])
}
