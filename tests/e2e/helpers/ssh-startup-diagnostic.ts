import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { isRecord } from '../../../src/shared/agent-status-child-work-value-guards'
import type { ChildProcessHandle } from '../../../src/shared/child-process/run-process'
import { runProcessSync } from '../../../src/shared/child-process/run-process'
import {
  SSH_STARTUP_DIAGNOSTIC_RUN_ENV,
  SSH_STARTUP_DIAGNOSTIC_LIMIT,
  sshStartupDiagnosticCommand
} from '../../../src/relay/pty-startup-diagnostic'
import {
  execDockerSshRelayTargetControlCommand,
  type DockerSshRelayTarget
} from './docker-ssh-relay-target'
import type { StartupExecTerminal } from './startup-exec-readiness-oracle'

const observers = new WeakMap<Page, SshStartupDiagnostic>()

export function observeStartupExecRuntime<TResult>(
  page: Page,
  method: string,
  params: unknown,
  startedNs: bigint,
  pending: Promise<TResult>
): Promise<TResult> {
  const observer = observers.get(page)
  if (!observer) {
    return pending
  }
  return pending.then(
    (result) => {
      observer.rpc(method, params, result, startedNs)
      return result
    },
    (error) => {
      observer.rpc(method, params, undefined, startedNs, String(error))
      throw error
    }
  )
}

export class SshStartupDiagnostic {
  private terminal: string | null = null
  private tabId: string | null = null
  private worktree: string | null = null
  private rpcBytes = 0
  private readonly rpcPath: string

  constructor(
    private readonly page: Page,
    private readonly target: DockerSshRelayTarget,
    private readonly runId: string,
    private readonly testInfo: TestInfo
  ) {
    if (!/^ssh_[0-9]{13}$/.test(runId)) {
      throw new Error('Invalid SSH diagnostic run')
    }
    mkdirSync(testInfo.outputDir, { recursive: true })
    this.rpcPath = testInfo.outputPath('ssh-startup-rpc.jsonl')
    execDockerSshRelayTargetControlCommand(
      target,
      `mkdir -m 700 '/tmp/sta4067-diagnostic-${runId}'`
    )
    observers.set(page, this)
  }

  shellEnv(): Record<string, string> {
    return { [SSH_STARTUP_DIAGNOSTIC_RUN_ENV]: this.runId }
  }

  rpc(method: string, params: unknown, result: unknown, startedNs: bigint, error?: string): void {
    if (!isRecord(params)) {
      return
    }
    let capturedResult = result
    if (method === 'session.tabs.createTerminal') {
      if (params.command !== sshStartupDiagnosticCommand(this.runId)) {
        return
      }
      if (
        isRecord(result) &&
        isRecord(result.tab) &&
        typeof result.tab.terminal === 'string' &&
        typeof result.tab.parentTabId === 'string'
      ) {
        this.terminal = result.tab.terminal
        this.tabId = result.tab.parentTabId
      }
      this.worktree = typeof params.worktree === 'string' ? params.worktree : null
    } else if (method === 'terminal.list') {
      if (
        params.worktree !== this.worktree ||
        !isRecord(result) ||
        !Array.isArray(result.terminals)
      ) {
        return
      }
      capturedResult = {
        terminals: result.terminals.filter(
          (row: unknown) =>
            isRecord(row) && row.handle === this.terminal && row.tabId === this.tabId
        )
      }
    } else if (
      !['terminal.show', 'terminal.read', 'terminal.closeTab'].includes(method) ||
      params.terminal !== this.terminal
    ) {
      return
    }
    const row = `${JSON.stringify({ method, params, result: capturedResult, error, startedNs: String(startedNs), endedNs: String(process.hrtime.bigint()) })}\n`
    const bytes = Buffer.byteLength(row)
    if (this.rpcBytes + bytes > SSH_STARTUP_DIAGNOSTIC_LIMIT) {
      return
    }
    try {
      appendFileSync(this.rpcPath, row, { mode: 0o600 })
      this.rpcBytes += bytes
    } catch {
      // Diagnostic storage cannot turn a successful RPC into a failure.
    }
  }

  async capture(
    phase: 'before-echo-assertion' | 'failure-before-finally' | 'success-before-finally',
    created: StartupExecTerminal | null
  ): Promise<void> {
    const startedNs = process.hrtime.bigint()
    const observations: Record<string, unknown> = {
      phase,
      created,
      observerOverheadChangesTiming: true
    }
    try {
      if (created) {
        for (const method of ['terminal.show', 'terminal.read']) {
          observations[method] = await this.page.evaluate(
            async ({ method, terminal }) =>
              window.api.runtime.call({ method, params: { terminal } }),
            { method, terminal: created.terminal }
          )
        }
      }
      const script = dockerObservationScript(this.runId)
      observations.docker = JSON.parse(
        execDockerSshRelayTargetControlCommand(
          this.target,
          `node -e '${script.replaceAll("'", "'\\''")}'`
        )
      )
      const docker = observations.docker
      if (isRecord(docker) && typeof docker.relayBase64 === 'string') {
        writeFileSync(
          this.testInfo.outputPath(`ssh-startup-${phase}-relay.jsonl`),
          Buffer.from(docker.relayBase64, 'base64'),
          { mode: 0o600 }
        )
        delete docker.relayBase64
      }
      if (phase === 'failure-before-finally') {
        await this.page.screenshot({
          path: this.testInfo.outputPath('ssh-startup-before-cleanup.png')
        })
      }
    } catch (error) {
      observations.captureError = String(error)
    }
    observations.startedNs = String(startedNs)
    observations.endedNs = String(process.hrtime.bigint())
    try {
      writeFileSync(
        this.testInfo.outputPath(`ssh-startup-${phase}.json`),
        `${JSON.stringify(observations, null, 2)}\n`,
        { mode: 0o600 }
      )
    } catch {
      // Preserve the original assertion when diagnostic storage fails.
    }
  }

  afterAppShutdown(child: ChildProcessHandle): void {
    const exited = child.exitCode !== null || child.signalCode !== null
    try {
      writeFileSync(
        this.testInfo.outputPath('ssh-startup-app-child-cleanup.json'),
        `${JSON.stringify({ pid: child.pid, spawnargs: child.spawnargs, exitCode: child.exitCode, signalCode: child.signalCode, verdict: exited ? 'exited' : 'unverifiable', childProcessObjectAttestsOwnedIncarnation: true }, null, 2)}\n`,
        { mode: 0o600 }
      )
    } catch {
      // Keep the existing teardown result when diagnostic storage fails.
    }
  }

  afterContainerCleanup(): void {
    observers.delete(this.page)
    try {
      const result = runProcessSync({
        program: 'docker',
        args: ['inspect', '--format', '{{.State.Running}}', this.target.containerName],
        timeoutMs: 10_000,
        maxOutputBytes: 4_096
      })
      const positivelyRemoved =
        result.code !== 0 && result.stderr.includes(`No such object: ${this.target.containerName}`)
      writeFileSync(
        this.testInfo.outputPath('ssh-startup-container-cleanup.json'),
        `${JSON.stringify({ container: this.target.containerName, code: result.code, stdout: result.stdout, stderr: result.stderr, positivelyRemoved, verdict: positivelyRemoved ? 'exited' : 'unverifiable', closeTabAloneDoesNotProveDeath: true }, null, 2)}\n`,
        { mode: 0o600 }
      )
    } catch {
      // Preserve original cleanup; missing proof remains unverifiable.
    }
  }
}

export function dockerObservationScript(runId: string): string {
  return `const fs=require("node:fs"), cp=require("node:child_process");
const root="/tmp/sta4067-diagnostic-${runId}", stem="/tmp/sta4067-${runId}";
const out={started:fs.existsSync(stem+".started"),released:fs.existsSync(stem+".release"),ledgerPresent:fs.existsSync(stem+".ledger"),slaveVerdict:"unverifiable"};
try {
 const bytes=fs.readFileSync(root+"/relay.jsonl");
 if(bytes.length>1048576) throw new Error("Diagnostic exceeded bound");
 out.relayBase64=bytes.toString("base64");
 const first=JSON.parse(bytes.toString("utf8").split("\\n")[0]);
 const pid=first.nativePid, slave=first.slavePath;
 if(first.event!=="created" || !Number.isInteger(pid) || pid<=1 || !/^\\/dev\\/pts\\/[0-9]+$/.test(slave)) throw new Error("Missing concrete owned slave");
 const stat=fs.readFileSync("/proc/"+pid+"/stat","utf8");
 const fields=stat.slice(stat.lastIndexOf(")")+2).split(" ");
 const fd=fs.readlinkSync("/proc/"+pid+"/fd/0"), exe=fs.readlinkSync("/proc/"+pid+"/exe");
 out.native={pid,startTicks:fields[19],foregroundGroup:fields[5],slave,fd,exe,argv:fs.readFileSync("/proc/"+pid+"/cmdline","utf8").split("\\0").filter(Boolean)};
 if(fields[19]!==first.nativeStartTicks || fd!==slave || !exe.endsWith("/bash")) throw new Error("Owned incarnation/slave mismatch");
 const stty=cp.spawnSync("stty",["-a"],{stdio:[fs.openSync(slave,"r"),"pipe","pipe"],encoding:"utf8",timeout:2000,maxBuffer:8192});
 out.slaveVerdict="live"; out.stty={code:stty.status,stdout:stty.stdout,stderr:stty.stderr,error:stty.error?.name};
} catch(error) {out.observationError=String(error);}
console.log(JSON.stringify(out));`
}
